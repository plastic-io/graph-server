/**
 * What a graph says it wants of a stack, and what it is told back
 * (plan §4.9.2, revised by D-41…D-45).
 *
 * The desired state is an ordinary edge value: a node assembles it from
 * whatever logic it likes and hands it to `host.deploy`.  Everything that
 * decides whether it may happen — who asked, at which revision, whether that
 * was approved, which accounts and regions are allowed — is derived by the
 * server and is deliberately absent from this interface.  A value that could
 * name its own actor would be a value that could name somebody else's.
 */

export interface ArtifactRef {
    graphId: string;
    nodeId: string;
    revisionId: string;
    /** The template's digest; also where it is stored (`iac/templates/<sha256>.yaml`). */
    sha256: string;
}

export type IacOperation = "plan" | "apply" | "destroy" | "cancel" | "detect-drift";

export interface IacDesiredState {
    schemaVersion: 1;
    stack: {
        name: string;
        account: string;
        region: string;
        environment: "dev" | "staging" | "prod";
    };
    template: { artifactRef: ArtifactRef; format: "yaml" | "json" };
    /**
     * Plain strings only.  A secret reaches a template as a CloudFormation
     * dynamic reference resolved under the execution role (D-42), so no secret
     * value passes through this server, a change set it can read, or an
     * observation.
     */
    parameters?: Record<string, string>;
    capabilities?: ("CAPABILITY_IAM" | "CAPABILITY_NAMED_IAM" | "CAPABILITY_AUTO_EXPAND")[];
    operation: IacOperation;
    trigger: { kind: "explicit"; approvalRef?: string } | { kind: "reconcile"; sourceRevision: string };
    correlation: { proposalId?: string; idempotencyKey: string };
}

/** What an environment allows, which is substrate configuration and never graph content. */
export interface IacPolicy {
    /** e.g. `pio-dev-`; every stack and every named resource must start with it. */
    stackPrefix: string;
    accounts: string[];
    regions: string[];
    /** Every role a template creates must carry this boundary. */
    permissionsBoundaryArn?: string;
    /** Stacks this instance runs on, which a template may never name (§4.9.6 policy 3). */
    substrateStacks: string[];
    /** Off by default: a nested stack is a template this validator never saw. */
    allowNestedStacks?: boolean;
    /** Off by default: a macro is code running with the execution role's authority. */
    allowTransforms?: boolean;
}

export const DEFAULT_POLICY: IacPolicy = {
    stackPrefix: "pio-dev-",
    accounts: [],
    regions: ["us-west-1"],
    substrateStacks: ["plastic-io-graph-server", "plastic-io-iac-orchestrator"],
};

export interface IacProblem {
    /** Stable, so a test and a message can name the same thing. */
    code:
        | "SCHEMA_INVALID" | "UNKNOWN_FIELD" | "UNSUPPORTED_OPERATION"
        | "STACK_NAME" | "STACK_PREFIX" | "ACCOUNT_NOT_ALLOWED" | "REGION_NOT_ALLOWED" | "SUBSTRATE_TARGET"
        | "SECRET_PARAMETER" | "EMBEDDED_CREDENTIAL"
        | "TEMPLATE_UNREADABLE" | "TEMPLATE_EMPTY" | "RESOURCE_SHAPE"
        | "CUSTOM_RESOURCE" | "MACRO" | "TRANSFORM" | "NESTED_STACK"
        | "IAM_WITHOUT_BOUNDARY" | "IAM_NEGATED_STATEMENT"
        | "OPEN_PRINCIPAL" | "FOREIGN_PRINCIPAL"
        | "NAME_OUTSIDE_PREFIX";
    message: string;
    /** Where in the template or the desired state, as a dotted path. */
    path?: string;
    resource?: string;
}

export interface TemplateValidation {
    ok: boolean;
    problems: IacProblem[];
    templateSha256: string;
    format: "yaml" | "json";
    counts: { resources: number; outputs: number; parameters: number };
    /** The resource types it declares, so a reviewer sees the shape at a glance. */
    resourceTypes: string[];
}
