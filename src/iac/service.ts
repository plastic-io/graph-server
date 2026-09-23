import { ulid } from "ulid";
import { createHash } from "crypto";
import { Principal } from "../auth/principal";
import { decide } from "../policy/decide";
import { IacDesiredState, IacPolicy, IacProblem, TemplateValidation } from "./types";
import { policyFromEnv, validateDesired, validateTemplate } from "./validator";

/**
 * Asking CloudFormation what a change would do (plan §4.9, M4a: D-43).
 *
 * This plans and nothing else.  A change set says what would happen without
 * anything happening, which is the half of the design that can be built before
 * the account, the orchestrator and the execution role exist — and it is the
 * half that is worth having first, because it is what a person reads before
 * approving anything.
 *
 * Nothing here can create, change or delete a resource: the only CloudFormation
 * calls are `CreateChangeSet`, `DescribeChangeSet` and `DeleteChangeSet`, the
 * change set is deleted once it has been read, and there is no code path that
 * executes one.  Applying is M4b, with the orchestrator, its roles and a
 * decision about which account it points at.
 */

export interface ChangeSetSummary {
    action: string;
    logicalId: string;
    resourceType: string;
    physicalId?: string;
    replacement?: string;
    scope?: string[];
}

/** What this service needs of CloudFormation, so a test can be sure of what it asked. */
export interface CloudFormationClient {
    createChangeSet(input: {
        stackName: string; templateBody: string; parameters: Record<string, string>;
        capabilities: string[]; clientRequestToken: string; changeSetName: string; changeSetType: "CREATE" | "UPDATE";
    }): Promise<{ changeSetId: string; stackId?: string }>;
    describeChangeSet(input: { changeSetId: string }): Promise<{
        status: string; statusReason?: string; executionStatus?: string; changes: ChangeSetSummary[];
    }>;
    deleteChangeSet(input: { changeSetId: string }): Promise<void>;
    /** Whether the stack is there, which decides CREATE against UPDATE. */
    stackExists(stackName: string): Promise<boolean>;
}

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
    list(prefix: string, cb: (err: any, data: any) => void): void;
}

export interface IacServiceDeps {
    /** The graph as a named revision projects it. */
    projection: (graphId: string, revisionId?: string) => Promise<{ revisionId: string; projection: any } | null>;
    /** The template as it was committed, by digest. */
    template: (sha256: string) => Promise<{ text: string; format: "yaml" | "json" } | null>;
    cloudformation?: CloudFormationClient;
    policy?: () => IacPolicy;
    observe?: (record: any) => Promise<void>;
    now?: () => Date;
    /** How long to wait for a change set to finish being made. */
    timeoutMs?: number;
    pollMs?: number;
}

export interface IacStatus {
    schemaVersion: 1;
    graphId: string;
    nodeId: string;
    stack: IacDesiredState["stack"];
    operation: "plan";
    state: "planning" | "planned" | "failed";
    requestedRevision: string;
    templateSha256: string;
    at: string;
    by: { sub: string; kind: string } | null;
    correlation: { idempotencyKey: string };
    validation?: TemplateValidation;
    plan?: { changeSetId: string; changes: ChangeSetSummary[]; destructive: boolean; changeSetRetained: boolean; stackExists: boolean };
    problems?: IacProblem[];
    reason?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** A change that takes something away, which is what a person is being asked about. */
const DESTRUCTIVE = ["Remove", "Replace"];

export class IacService {
    constructor(private store: Store, private deps: IacServiceDeps) {}

    static statusKey(stack: { account: string; region: string; name: string }) {
        return `iac/stacks/${stack.account}/${stack.region}/${stack.name}/status.json`;
    }
    static templateKey(sha256: string, format: "yaml" | "json") {
        return `iac/templates/${sha256}.${format}`;
    }

    private getJson(key: string): Promise<any | null> {
        return new Promise((resolve) => this.store.get(key, (err: any, data: any) => resolve(err ? null : data)));
    }
    private putJson(key: string, value: any): Promise<void> {
        return new Promise((resolve, reject) => this.store.set(key, value, {}, (err: any) => (err ? reject(err) : resolve())));
    }
    private policy(): IacPolicy {
        return this.deps.policy ? this.deps.policy() : policyFromEnv();
    }
    private now(): Date {
        return this.deps.now ? this.deps.now() : new Date();
    }

    /** The desired state a node carries, as the document holds it. */
    static desiredOf(node: any): any {
        return node && node.properties && node.properties.iac;
    }

    /**
     * The desired state as it will be acted on: what the node says, plus what
     * only the server may say — which revision it was read at, which template
     * digest that revision carried, who asked, and a key that makes a retry
     * the same request rather than a second one.
     */
    static desiredFor(graphId: string, nodeId: string, revisionId: string, carried: any, sha256: string, idempotencyKey: string): any {
        return {
            schemaVersion: 1,
            stack: carried.stack,
            template: { artifactRef: { graphId, nodeId, revisionId, sha256 }, format: (carried.template && carried.template.format) || "yaml" },
            ...(carried.parameters ? { parameters: carried.parameters } : {}),
            ...(carried.capabilities ? { capabilities: carried.capabilities } : {}),
            operation: "plan",
            trigger: { kind: "explicit" },
            correlation: { idempotencyKey },
        };
    }

    async status(graphId: string, nodeId: string, principal: Principal | undefined, revisionId?: string): Promise<any> {
        const allowed = decide(principal, ["iac:read-status"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const found = await this.resolve(graphId, nodeId, revisionId);
        if (found.error) {
            return found;
        }
        const status = await this.getJson(IacService.statusKey(found.carried.stack));
        return status || { graphId, nodeId, stack: found.carried.stack, state: "never-planned" };
    }

    private async resolve(graphId: string, nodeId: string, revisionId?: string): Promise<any> {
        const at = await this.deps.projection(graphId, revisionId);
        if (!at) {
            return { error: `no graph ${graphId}${revisionId ? " at " + revisionId : ""}`, code: "NOT_FOUND" };
        }
        const node = ((at.projection && at.projection.nodes) || []).find((n: any) => n.id === nodeId || n.url === nodeId);
        if (!node) {
            return { error: `no node ${nodeId}`, code: "NOT_FOUND" };
        }
        const carried = IacService.desiredOf(node);
        if (!carried || typeof carried !== "object") {
            return { error: `node ${nodeId} carries no desired state`, code: "NOT_FOUND" };
        }
        if (!carried.stack || typeof carried.stack !== "object") {
            return { error: "the desired state names no stack", code: "SCHEMA_INVALID" };
        }
        return { revisionId: at.revisionId, node, carried };
    }

    /**
     * Ask CloudFormation what this desired state would do.  Answers with the
     * change set summary and nothing that has changed.
     */
    /**
     * What a node asked for, as a plan.  The template and the stack come from
     * the document — validated when the revision was cut and addressed by
     * digest — and only the parameters come from the value the node assembled,
     * because a template that could arrive at run time is a template nothing
     * validated (PB-096).
     */
    async fromHost(request: { graphId: string; nodeId: string; principal?: any; desired?: any }): Promise<any> {
        const desired = request.desired || {};
        return this.plan(request.graphId, request.nodeId, request.principal, {
            parameters: desired.parameters,
            idempotencyKey: desired.correlation && desired.correlation.idempotencyKey,
        });
    }

    async plan(graphId: string, nodeId: string, principal: Principal | undefined, options: { revisionId?: string; idempotencyKey?: string; parameters?: Record<string, any> } = {}): Promise<any> {
        const allowed = decide(principal, ["iac:propose"]);
        if (!allowed.allow) {
            return { error: allowed.reason || "denied", code: "ADMISSION_DENIED" };
        }
        const found = await this.resolve(graphId, nodeId, options.revisionId);
        if (found.error) {
            return found;
        }
        const { revisionId, carried } = found;
        const policy = this.policy();
        const at = this.now().toISOString();
        const idempotencyKey = options.idempotencyKey || ulid();

        const template = carried.template || {};
        const text: string | undefined = typeof template.text === "string" ? template.text : undefined;
        const format: "yaml" | "json" = template.format === "json" ? "json" : "yaml";
        if (!text) {
            return { error: "the desired state carries no template", code: "SCHEMA_INVALID" };
        }
        const sha256 = createHash("sha256").update(text).digest("hex");

        // The policy may have changed since the revision was cut, so the
        // template is validated again here rather than trusted because it was
        // once accepted.
        const validation = validateTemplate(text, format, policy);
        const withParameters = options.parameters === undefined ? carried : { ...carried, parameters: { ...(carried.parameters || {}), ...options.parameters } };
        const desired = IacService.desiredFor(graphId, nodeId, revisionId, withParameters, sha256, idempotencyKey);
        const shape = validateDesired(desired, policy);
        const problems = [...validation.problems, ...shape.problems];

        const base: IacStatus = {
            schemaVersion: 1, graphId, nodeId, stack: carried.stack, operation: "plan",
            state: "planning", requestedRevision: revisionId, templateSha256: sha256, at,
            by: principal ? { sub: principal.sub, kind: principal.kind } : null,
            correlation: { idempotencyKey }, validation,
        };
        if (problems.length) {
            const refused: IacStatus = { ...base, state: "failed", problems, reason: "this desired state is not one this environment allows" };
            await this.record(refused);
            return { error: refused.reason, code: "IAC_REFUSED", problems, validation };
        }
        if (!this.deps.cloudformation) {
            const unsupported: IacStatus = { ...base, state: "failed", reason: "this instance holds no CloudFormation authority" };
            await this.record(unsupported);
            return {
                error: "this instance holds no CloudFormation authority, so it can validate a desired state but not plan one (the account it would point at is decided with the orchestrator)",
                code: "UNSUPPORTED", validation,
            };
        }

        await this.record(base);
        try {
            const exists = await this.deps.cloudformation.stackExists(carried.stack.name);
            const created = await this.deps.cloudformation.createChangeSet({
                stackName: carried.stack.name,
                templateBody: text,
                parameters: desired.parameters || {},
                capabilities: carried.capabilities || [],
                clientRequestToken: idempotencyKey,
                changeSetName: `plan-${idempotencyKey}`,
                changeSetType: exists ? "UPDATE" : "CREATE",
            });
            const settled = await this.awaitChangeSet(created.changeSetId);
            const changes = settled.changes || [];
            // A change set that finds nothing to do says so as a failure; that
            // is CloudFormation's way of saying the stack already matches.
            const empty = settled.status === "FAILED" && /didn't contain changes|No updates are to be performed/i.test(settled.statusReason || "");
            if (settled.status === "FAILED" && !empty) {
                const failed: IacStatus = { ...base, state: "failed", reason: settled.statusReason || "CloudFormation could not make a change set" };
                await this.cleanUp(created.changeSetId);
                await this.record(failed);
                return { error: failed.reason, code: "IAC_PLAN_FAILED", validation };
            }
            const planned: IacStatus = {
                ...base,
                state: "planned",
                plan: {
                    changeSetId: created.changeSetId,
                    changes,
                    destructive: changes.some((c) => DESTRUCTIVE.includes(c.action) || (c.replacement && c.replacement !== "False")),
                    // Nothing can execute one yet, so it is not left behind.
                    changeSetRetained: false,
                    stackExists: exists,
                },
            };
            await this.cleanUp(created.changeSetId);
            await this.record(planned);
            return { status: planned, plan: planned.plan, validation, revisionId };
        } catch (err: any) {
            const message = (err && err.message) || String(err);
            const denied = /AccessDenied|not authorized|AccessDeniedException/i.test(message);
            const failed: IacStatus = { ...base, state: "failed", reason: denied ? "this instance is not permitted to plan against that account" : message };
            await this.record(failed);
            return { error: failed.reason, code: denied ? "ADMISSION_DENIED" : "IAC_PLAN_FAILED", validation };
        }
    }

    /** Wait for the change set to be made, by asking; there is no callback to wait on. */
    private async awaitChangeSet(changeSetId: string): Promise<{ status: string; statusReason?: string; changes: ChangeSetSummary[] }> {
        const timeoutMs = this.deps.timeoutMs === undefined ? 120000 : this.deps.timeoutMs;
        const pollMs = this.deps.pollMs === undefined ? 2000 : this.deps.pollMs;
        const until = Date.now() + timeoutMs;
        for (;;) {
            const described = await this.deps.cloudformation!.describeChangeSet({ changeSetId });
            if (described.status !== "CREATE_IN_PROGRESS" && described.status !== "CREATE_PENDING") {
                return { status: described.status, statusReason: described.statusReason, changes: described.changes || [] };
            }
            if (Date.now() >= until) {
                return { status: "FAILED", statusReason: `the change set was still being made after ${Math.round(timeoutMs / 1000)}s`, changes: [] };
            }
            await sleep(pollMs);
        }
    }

    private async cleanUp(changeSetId: string): Promise<void> {
        try {
            await this.deps.cloudformation!.deleteChangeSet({ changeSetId });
        } catch (err) {
            // A change set left behind is litter, not a failure of the plan.
            console.error("Cannot delete a change set.", err);
        }
    }

    /** The durable status, and the observation that says the same thing to whoever is watching. */
    private async record(status: IacStatus): Promise<void> {
        try {
            await this.putJson(IacService.statusKey(status.stack), status);
        } catch (err) {
            console.error("Cannot write an IaC status document.", err);
        }
        if (this.deps.observe) {
            try {
                await this.deps.observe({
                    kind: "deploy.status", at: status.at, graphId: status.graphId, nodeId: status.nodeId,
                    stack: status.stack, operation: status.operation, state: status.state,
                    requestedRevision: status.requestedRevision, templateSha256: status.templateSha256,
                    destructive: status.plan ? status.plan.destructive : undefined,
                    changes: status.plan ? status.plan.changes.length : undefined,
                    reason: status.reason,
                });
            } catch (err) {
                console.error("Cannot record a deployment observation.", err);
            }
        }
    }
}
