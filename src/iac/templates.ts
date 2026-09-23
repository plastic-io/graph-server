import { createHash } from "crypto";
import { IacPolicy, IacProblem } from "./types";
import { policyFromEnv, validateStack, validateTemplate } from "./validator";

/**
 * Templates become artifacts when a revision is cut (PB-096).
 *
 * A template lives in the document, where it is versioned, diffed and reviewed
 * like any other content — but CloudFormation has to read it from somewhere
 * immutable, addressed by digest, because a plan and the apply that follows it
 * must be about the same bytes.  Cutting a revision is where those two facts
 * meet: the text as committed is written to `iac/templates/<sha256>.<format>`,
 * and the revision records which node carried which digest.
 *
 * It is also where the validator runs, which is the point: **a revision
 * carrying a template this environment would refuse is not cut at all**.  The
 * alternative — cutting it and refusing later — leaves a named, immutable
 * state that cannot be deployed, and leaves the refusal to the moment somebody
 * is trying to deploy rather than the moment they are writing.
 *
 * The write is content-addressed, so cutting the same template twice writes
 * the same bytes to the same key and nothing is ever overwritten with
 * something different.
 */

export interface TemplateRecord {
    nodeId: string;
    sha256: string;
    format: "yaml" | "json";
    stack: { name: string; account: string; region: string; environment: string };
    resources: number;
    resourceTypes: string[];
}

export interface TemplateProblem extends IacProblem {
    nodeId: string;
}

interface Store {
    get(key: string, cb: (err: any, data: any) => void): void;
    set(key: string, val: any, meta: any, cb: (err: any, data: any) => void): void;
}

export class TemplateStore {
    constructor(private store: Store, private deps: { policy?: () => IacPolicy } = {}) {}

    static key(sha256: string, format: "yaml" | "json") {
        return `iac/templates/${sha256}.${format}`;
    }

    private policy(): IacPolicy {
        return this.deps.policy ? this.deps.policy() : policyFromEnv();
    }

    /** The nodes carrying infrastructure, in the order the projection has them. */
    static carriers(projection: any): { nodeId: string; iac: any }[] {
        return ((projection && projection.nodes) || [])
            .filter((node: any) => node && node.properties && node.properties.iac && node.properties.iac.template && typeof node.properties.iac.template.text === "string")
            .map((node: any) => ({ nodeId: node.id, iac: node.properties.iac }));
    }

    /**
     * Validate every template this projection carries and write the ones that
     * pass.  Nothing is written when anything fails, because a revision that
     * is refused should leave nothing behind.
     */
    async writeFor(projection: any): Promise<{ ok: boolean; problems: TemplateProblem[]; templates: TemplateRecord[] }> {
        const policy = this.policy();
        const carriers = TemplateStore.carriers(projection);
        const problems: TemplateProblem[] = [];
        const pending: { record: TemplateRecord; text: string }[] = [];

        for (const { nodeId, iac } of carriers) {
            const format: "yaml" | "json" = iac.template.format === "json" ? "json" : "yaml";
            const text: string = iac.template.text;
            const validation = validateTemplate(text, format, policy);
            validation.problems.forEach((problem) => problems.push({ ...problem, nodeId }));
            validateStack(iac.stack, policy).forEach((problem) => problems.push({ ...problem, nodeId }));
            if (!validation.ok) {
                continue;
            }
            pending.push({
                text,
                record: {
                    nodeId,
                    sha256: createHash("sha256").update(text).digest("hex"),
                    format,
                    stack: iac.stack,
                    resources: validation.counts.resources,
                    resourceTypes: validation.resourceTypes,
                },
            });
        }
        if (problems.length) {
            return { ok: false, problems, templates: [] };
        }
        for (const { record, text } of pending) {
            await new Promise<void>((resolve, reject) => this.store.set(TemplateStore.key(record.sha256, record.format), text, { ContentType: "text/plain" }, (err: any) => (err ? reject(err) : resolve())));
        }
        return { ok: true, problems: [], templates: pending.map((p) => p.record) };
    }

    /** A template as it was committed, for a plan that must be about those bytes. */
    async read(sha256: string, format: "yaml" | "json" = "yaml"): Promise<{ text: string; format: "yaml" | "json" } | null> {
        const text = await new Promise<any>((resolve) => this.store.get(TemplateStore.key(sha256, format), (err: any, data: any) => resolve(err ? null : data)));
        if (typeof text !== "string") {
            return null;
        }
        return { text, format };
    }
}
