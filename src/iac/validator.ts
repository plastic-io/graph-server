import { createHash } from "crypto";
import { parse as parseYaml } from "yaml";
import { CHEAP_RESOURCE_TYPES, DEFAULT_POLICY, IacDesiredState, IacPolicy, IacProblem, TemplateValidation } from "./types";

/**
 * What a template is allowed to be (plan §4.9.6, PB-091).
 *
 * The IAM boundary is what stops a deployment doing damage; this is what stops
 * one being *attempted* — earlier, where the answer can name the resource and
 * the line rather than an AWS error twenty minutes later, and where a person
 * reviewing a proposal can read it.  The two are not alternatives: every check
 * here has a policy behind it, and nothing here is load-bearing on its own.
 *
 * Deliberately refused, each because it is a way to execute code or hand out
 * authority that the rest of the design cannot see:
 *
 *   - custom resources and macros run arbitrary code with the execution
 *     role's authority, on a Lambda this validator never examined;
 *   - a nested stack is a template that arrived by URL, which is to say a
 *     template nobody validated;
 *   - a role without the permissions boundary is a role that can be given
 *     anything later;
 *   - `NotAction` and `NotResource` invert a statement's meaning, so a policy
 *     that reads as a grant of one thing is a grant of everything else;
 *   - a resource policy naming `*` or a foreign account hands the resource
 *     outside the account the graph belongs to;
 *   - a name outside the stack prefix reaches resources this environment does
 *     not own, which is how a deployment touches the substrate.
 *
 * The validator runs before a revision is cut (PB-096), so an invalid template
 * never becomes a revision, and again before a plan, because the policy may
 * have changed since.
 */

const STACK_NAME = /^[A-Za-z][A-Za-z0-9-]{0,127}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ACCOUNT = /^[0-9]{12}$/;
const ACCESS_KEY = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/;
const PRIVATE_KEY = /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/;

/** Types whose `Name` property names a real thing in the account. */
const NAMED_PROPERTIES: Record<string, string[]> = {
    "AWS::S3::Bucket": ["BucketName"],
    "AWS::IAM::Role": ["RoleName"],
    "AWS::IAM::User": ["UserName"],
    "AWS::IAM::Group": ["GroupName"],
    "AWS::IAM::ManagedPolicy": ["ManagedPolicyName"],
    "AWS::Lambda::Function": ["FunctionName"],
    "AWS::DynamoDB::Table": ["TableName"],
    "AWS::SQS::Queue": ["QueueName"],
    "AWS::SNS::Topic": ["TopicName"],
    "AWS::Logs::LogGroup": ["LogGroupName"],
    "AWS::Events::Rule": ["Name"],
    "AWS::StepFunctions::StateMachine": ["StateMachineName"],
    "AWS::CodeBuild::Project": ["Name"],
    "AWS::Cognito::UserPool": ["UserPoolName"],
    "AWS::ApiGateway::RestApi": ["Name"],
    "AWS::Secretsmanager::Secret": ["Name"],
    "AWS::SecretsManager::Secret": ["Name"],
};

const ROLE_TYPES = ["AWS::IAM::Role", "AWS::IAM::User"];

/**
 * CloudFormation's short tags are the ordinary way to write a template, so a
 * parser that cannot read them is a validator that cannot see the template.
 * Each becomes the long form it means, which is what the checks below read.
 */
const SHORT_TAGS = ["Ref", "Condition", "GetAtt", "Sub", "Join", "Select", "Split", "FindInMap", "ImportValue",
    "GetAZs", "Base64", "Cidr", "Transform", "And", "Or", "Not", "Equals", "If", "ToJsonString", "Length"];

const customTags = SHORT_TAGS.map((name) => ({
    tag: `!${name}`,
    collection: undefined as any,
    resolve(value: any) {
        const key = name === "Ref" || name === "Condition" ? name : `Fn::${name}`;
        return { [key]: value };
    },
}));

function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

/** Every value in the tree, with the path that reached it. */
function walk(node: any, path: string, visit: (value: any, path: string) => void): void {
    visit(node, path);
    if (Array.isArray(node)) {
        node.forEach((item, i) => walk(item, `${path}[${i}]`, visit));
        return;
    }
    if (node && typeof node === "object") {
        Object.keys(node).forEach((key) => walk(node[key], path ? `${path}.${key}` : key, visit));
    }
}

/** Account ids named anywhere in a value (ARNs, `AWS` principals, plain ids). */
function accountsIn(value: any): string[] {
    const found = new Set<string>();
    walk(value, "", (v) => {
        if (typeof v !== "string") {
            return;
        }
        const arn = v.match(/arn:[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:([0-9]{12}):/);
        if (arn) {
            found.add(arn[1]);
        } else if (ACCOUNT.test(v)) {
            found.add(v);
        }
    });
    return Array.from(found);
}

function parseTemplate(text: string, format: "yaml" | "json"): { doc?: any; error?: string } {
    try {
        if (format === "json") {
            return { doc: JSON.parse(text) };
        }
        return { doc: parseYaml(text, { customTags, strict: false }) };
    } catch (err: any) {
        return { error: (err && err.message) || String(err) };
    }
}

export function validateTemplate(text: string, format: "yaml" | "json" = "yaml", policy: IacPolicy = DEFAULT_POLICY): TemplateValidation {
    const problems: IacProblem[] = [];
    const push = (code: IacProblem["code"], message: string, path?: string, resource?: string) => problems.push({ code, message, path, resource });
    const templateSha256 = sha256(text);
    const empty: TemplateValidation = { ok: false, problems, templateSha256, format, counts: { resources: 0, outputs: 0, parameters: 0 }, resourceTypes: [] };

    const { doc, error } = parseTemplate(text, format);
    if (error) {
        push("TEMPLATE_UNREADABLE", `this is not readable as ${format}: ${error}`);
        return empty;
    }
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
        push("TEMPLATE_UNREADABLE", "a template is an object with a Resources section");
        return empty;
    }
    const resources = doc.Resources;
    if (!resources || typeof resources !== "object" || Array.isArray(resources) || !Object.keys(resources).length) {
        push("TEMPLATE_EMPTY", "a template with no Resources deploys nothing");
        return empty;
    }

    if (doc.Transform !== undefined && !policy.allowTransforms) {
        push("TRANSFORM", "a transform is a macro, which runs code with the deployment's own authority before anything here has seen the result", "Transform");
    }
    walk(doc, "", (value, path) => {
        if (value && typeof value === "object" && !Array.isArray(value) && Object.prototype.hasOwnProperty.call(value, "Fn::Transform") && !policy.allowTransforms) {
            push("TRANSFORM", "Fn::Transform runs a macro over part of this template", path || "Fn::Transform");
        }
        if (typeof value === "string") {
            if (ACCESS_KEY.test(value)) {
                push("EMBEDDED_CREDENTIAL", "this looks like an AWS access key id written into the template; a secret belongs in a dynamic reference", path);
            }
            if (PRIVATE_KEY.test(value)) {
                push("EMBEDDED_CREDENTIAL", "this looks like a private key written into the template", path);
            }
        }
    });

    const logical = Object.keys(resources);
    if (policy.maxResources && logical.length > policy.maxResources) {
        push("TOO_MANY_RESOURCES", `${logical.length} resources is more than the ${policy.maxResources} this environment deploys in one stack`, "Resources");
        return { ...empty, counts: { resources: logical.length, outputs: 0, parameters: 0 } };
    }
    const resourceTypes: string[] = [];
    const ownAccounts = policy.accounts.length ? policy.accounts : [];
    Object.keys(resources).forEach((logicalId) => {
        const resource = resources[logicalId];
        const at = `Resources.${logicalId}`;
        if (!resource || typeof resource !== "object" || typeof resource.Type !== "string") {
            push("RESOURCE_SHAPE", "every resource needs a Type", at, logicalId);
            return;
        }
        const type = resource.Type;
        resourceTypes.push(type);
        const properties = (resource.Properties && typeof resource.Properties === "object") ? resource.Properties : {};

        // What it costs to leave running is a property of the type, so it is
        // asked first: an allow-list, because the expensive corners of AWS are
        // many and new ones arrive.
        if (policy.allowedResourceTypes && policy.allowedResourceTypes.length && !policy.allowedResourceTypes.includes(type)) {
            push("RESOURCE_TYPE_NOT_ALLOWED", `${type} is not one of the resource types this environment deploys; the list is what costs nothing while it sits idle, and widening it is a decision about the bill`, `${at}.Type`, logicalId);
        }
        if (type === "AWS::DynamoDB::Table" || type === "AWS::DynamoDB::GlobalTable") {
            const provisioned = properties.BillingMode !== undefined ? properties.BillingMode !== "PAY_PER_REQUEST" : !!properties.ProvisionedThroughput;
            if (provisioned) {
                push("COST_PROVISIONED", "provisioned capacity is billed whether or not anything reads or writes; PAY_PER_REQUEST is not", `${at}.Properties.BillingMode`, logicalId);
            }
        }
        if (type === "AWS::Logs::LogGroup" && properties.RetentionInDays === undefined) {
            push("COST_UNBOUNDED", "a log group with no RetentionInDays keeps everything for ever, and storage is the part of logging that does not stop costing", `${at}.Properties.RetentionInDays`, logicalId);
        }
        if (properties.ProvisionedConcurrencyConfig !== undefined) {
            push("COST_PROVISIONED", "provisioned concurrency is billed while it is reserved, whether or not anything calls it", `${at}.Properties.ProvisionedConcurrencyConfig`, logicalId);
        }

        if (/^Custom::/.test(type) || type === "AWS::CloudFormation::CustomResource") {
            push("CUSTOM_RESOURCE", "a custom resource runs code of its own with this deployment's authority, and nothing here can see what that code does", `${at}.Type`, logicalId);
        }
        if (type === "AWS::CloudFormation::Macro") {
            push("MACRO", "a macro rewrites templates, including ones this validator has already passed", `${at}.Type`, logicalId);
        }
        if (type === "AWS::CloudFormation::Stack" && !policy.allowNestedStacks) {
            push("NESTED_STACK", "a nested stack deploys a template fetched by URL, which is a template nobody validated", `${at}.Type`, logicalId);
        }
        if (ROLE_TYPES.includes(type) && policy.permissionsBoundaryArn && properties.PermissionsBoundary !== policy.permissionsBoundaryArn) {
            push("IAM_WITHOUT_BOUNDARY", `every role this deployment creates carries the permissions boundary ${policy.permissionsBoundaryArn}; without it the role can be given anything later`, `${at}.Properties.PermissionsBoundary`, logicalId);
        }

        // policy documents, wherever they sit on the resource
        walk(properties, at + ".Properties", (value, path) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) {
                return;
            }
            if (value.NotAction !== undefined) {
                push("IAM_NEGATED_STATEMENT", "NotAction grants everything except what it lists, which is the opposite of what it reads as", path);
            }
            if (value.NotResource !== undefined) {
                push("IAM_NEGATED_STATEMENT", "NotResource grants every resource except those listed", path);
            }
            const principal = value.Principal;
            if (principal !== undefined && (value.Effect === undefined || value.Effect === "Allow")) {
                const open = principal === "*" || (principal && typeof principal === "object" && (principal.AWS === "*" || (Array.isArray(principal.AWS) && principal.AWS.includes("*"))));
                if (open) {
                    push("OPEN_PRINCIPAL", "this grants the resource to every principal in every account", `${path}.Principal`, logicalId);
                }
                const foreign = accountsIn(principal).filter((id) => ownAccounts.length && !ownAccounts.includes(id));
                if (foreign.length) {
                    push("FOREIGN_PRINCIPAL", `this grants the resource to account ${foreign.join(", ")}, which this environment does not own`, `${path}.Principal`, logicalId);
                }
            }
        });

        (NAMED_PROPERTIES[type] || []).forEach((property) => {
            const name = properties[property];
            if (typeof name !== "string") {
                return;   // absent, or a Ref/Sub the deployment resolves; the prefix is enforced by IAM either way
            }
            if (!name.startsWith(policy.stackPrefix)) {
                push("NAME_OUTSIDE_PREFIX", `${property} "${name}" is outside this environment's prefix "${policy.stackPrefix}", so it names something this environment does not own`, `${at}.Properties.${property}`, logicalId);
            }
            if (policy.substrateStacks.some((stack) => name.startsWith(stack))) {
                push("SUBSTRATE_TARGET", `${property} "${name}" names the substrate this server runs on`, `${at}.Properties.${property}`, logicalId);
            }
        });
    });

    return {
        ok: problems.length === 0,
        problems,
        templateSha256,
        format,
        counts: {
            resources: Object.keys(resources).length,
            outputs: doc.Outputs && typeof doc.Outputs === "object" ? Object.keys(doc.Outputs).length : 0,
            parameters: doc.Parameters && typeof doc.Parameters === "object" ? Object.keys(doc.Parameters).length : 0,
        },
        resourceTypes: Array.from(new Set(resourceTypes)).sort(),
    };
}

/**
 * Which stack, in which account and region — the part of a desired state the
 * document owns, and so the part that can be checked when a revision is cut,
 * before there is an operation or an idempotency key to speak of (PB-096).
 */
export function validateStack(stack: any, policy: IacPolicy = DEFAULT_POLICY): IacProblem[] {
    const problems: IacProblem[] = [];
    const push = (code: IacProblem["code"], message: string, path?: string) => problems.push({ code, message, path });
    if (!stack || typeof stack !== "object" || Array.isArray(stack)) {
        push("SCHEMA_INVALID", "stack says which stack, in which account and region", "stack");
        return problems;
    }
    Object.keys(stack).forEach((key) => {
        if (!STACK_KEYS.includes(key)) push("UNKNOWN_FIELD", `stack.${key} is not part of a desired state`, `stack.${key}`);
    });
    if (typeof stack.name !== "string" || !STACK_NAME.test(stack.name)) {
        push("STACK_NAME", "a stack name starts with a letter and is letters, digits and hyphens, up to 128 characters", "stack.name");
    } else if (!stack.name.startsWith(policy.stackPrefix)) {
        push("STACK_PREFIX", `this environment deploys stacks named "${policy.stackPrefix}…"; "${stack.name}" is outside it`, "stack.name");
    } else if (policy.substrateStacks.some((s) => stack.name.startsWith(s))) {
        push("SUBSTRATE_TARGET", "this names the substrate this server runs on, which is never deployed from a graph", "stack.name");
    }
    if (typeof stack.account !== "string" || !ACCOUNT.test(stack.account)) {
        push("SCHEMA_INVALID", "account is a twelve digit AWS account id", "stack.account");
    } else if (policy.accounts.length && !policy.accounts.includes(stack.account)) {
        push("ACCOUNT_NOT_ALLOWED", `this environment does not deploy into account ${stack.account}`, "stack.account");
    }
    if (typeof stack.region !== "string" || (policy.regions.length && !policy.regions.includes(stack.region))) {
        push("REGION_NOT_ALLOWED", `this environment deploys in ${policy.regions.join(", ") || "no region yet"}`, "stack.region");
    }
    if (!["dev", "staging", "prod"].includes(stack.environment)) {
        push("SCHEMA_INVALID", "environment is dev, staging or prod", "stack.environment");
    }
    return problems;
}

const DESIRED_KEYS = ["schemaVersion", "stack", "template", "parameters", "capabilities", "operation", "trigger", "correlation"];
const STACK_KEYS = ["name", "account", "region", "environment"];
const OPERATIONS: string[] = ["plan", "apply", "destroy", "cancel", "detect-drift"];
/** What this milestone can do: a change set and nothing that changes a resource (D-43). */
export const SUPPORTED_OPERATIONS: string[] = ["plan"];

export function validateDesired(desired: any, policy: IacPolicy = DEFAULT_POLICY): { ok: boolean; problems: IacProblem[]; desired?: IacDesiredState } {
    const problems: IacProblem[] = [];
    const push = (code: IacProblem["code"], message: string, path?: string) => problems.push({ code, message, path });
    if (!desired || typeof desired !== "object" || Array.isArray(desired)) {
        push("SCHEMA_INVALID", "a desired state is an object");
        return { ok: false, problems };
    }
    Object.keys(desired).forEach((key) => {
        if (!DESIRED_KEYS.includes(key)) {
            push("UNKNOWN_FIELD", `${key} is not part of a desired state; nothing would read it`, key);
        }
    });
    if (desired.schemaVersion !== 1) {
        push("SCHEMA_INVALID", "schemaVersion 1 is the only one this server knows", "schemaVersion");
    }

    validateStack(desired.stack, policy).forEach((problem) => problems.push(problem));

    const template = desired.template;
    if (!template || typeof template !== "object" || !template.artifactRef || typeof template.artifactRef !== "object") {
        push("SCHEMA_INVALID", "template names the artifact to deploy, by digest", "template.artifactRef");
    } else {
        const ref = template.artifactRef;
        ["graphId", "nodeId", "revisionId"].forEach((key) => {
            if (typeof ref[key] !== "string" || !ref[key]) push("SCHEMA_INVALID", `artifactRef.${key} is missing`, `template.artifactRef.${key}`);
        });
        if (typeof ref.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(ref.sha256)) {
            push("SCHEMA_INVALID", "artifactRef.sha256 is the template's digest, which is also where it is stored", "template.artifactRef.sha256");
        }
        if (template.format !== "yaml" && template.format !== "json") {
            push("SCHEMA_INVALID", "format is yaml or json", "template.format");
        }
    }

    if (desired.parameters !== undefined) {
        if (!desired.parameters || typeof desired.parameters !== "object" || Array.isArray(desired.parameters)) {
            push("SCHEMA_INVALID", "parameters is an object of strings", "parameters");
        } else {
            Object.keys(desired.parameters).forEach((key) => {
                const value = desired.parameters[key];
                if (value && typeof value === "object" && "secretRef" in value) {
                    push("SECRET_PARAMETER", "a secret does not travel as a parameter value; write it into the template as a dynamic reference, which CloudFormation resolves under the execution role so the value never reaches this server", `parameters.${key}`);
                    return;
                }
                if (typeof value !== "string") {
                    push("SCHEMA_INVALID", "a parameter value is a string", `parameters.${key}`);
                    return;
                }
                if (ACCESS_KEY.test(value) || PRIVATE_KEY.test(value)) {
                    push("EMBEDDED_CREDENTIAL", "this parameter looks like a credential; use a dynamic reference", `parameters.${key}`);
                }
            });
        }
    }

    if (desired.capabilities !== undefined) {
        if (!Array.isArray(desired.capabilities)) {
            push("SCHEMA_INVALID", "capabilities is a list", "capabilities");
        } else {
            desired.capabilities.forEach((c: any, i: number) => {
                if (!["CAPABILITY_IAM", "CAPABILITY_NAMED_IAM", "CAPABILITY_AUTO_EXPAND"].includes(c)) {
                    push("SCHEMA_INVALID", `${c} is not a CloudFormation capability`, `capabilities[${i}]`);
                } else if (c === "CAPABILITY_AUTO_EXPAND" && !policy.allowTransforms) {
                    push("TRANSFORM", "CAPABILITY_AUTO_EXPAND is consent for macros to rewrite the template", `capabilities[${i}]`);
                }
            });
        }
    }

    if (!OPERATIONS.includes(desired.operation)) {
        push("SCHEMA_INVALID", `operation is one of ${OPERATIONS.join(", ")}`, "operation");
    } else if (!SUPPORTED_OPERATIONS.includes(desired.operation)) {
        push("UNSUPPORTED_OPERATION", `this server can ${SUPPORTED_OPERATIONS.join(", ")}; ${desired.operation} needs the orchestrator, which is not deployed`, "operation");
    }

    const trigger = desired.trigger;
    if (!trigger || typeof trigger !== "object" || (trigger.kind !== "explicit" && trigger.kind !== "reconcile")) {
        push("SCHEMA_INVALID", "trigger says whether somebody asked for this or a revision changed it", "trigger");
    } else if (trigger.kind === "reconcile" && typeof trigger.sourceRevision !== "string") {
        push("SCHEMA_INVALID", "a reconcile trigger names the revision that changed", "trigger.sourceRevision");
    }

    const correlation = desired.correlation;
    if (!correlation || typeof correlation !== "object" || typeof correlation.idempotencyKey !== "string" || !ULID.test(correlation.idempotencyKey)) {
        push("SCHEMA_INVALID", "correlation.idempotencyKey is a ULID, and is what stops a retry starting a second operation", "correlation.idempotencyKey");
    }

    return { ok: problems.length === 0, problems, desired: problems.length === 0 ? (desired as IacDesiredState) : undefined };
}

/** The policy an environment runs under, from substrate configuration only. */
export function policyFromEnv(env: Record<string, string | undefined> = process.env): IacPolicy {
    const list = (value: string | undefined) => (value || "").split(",").map((s) => s.trim()).filter(Boolean);
    const types = list(env.IAC_ALLOWED_TYPES);
    return {
        stackPrefix: env.IAC_STACK_PREFIX || DEFAULT_POLICY.stackPrefix,
        allowedResourceTypes: types.length ? types : CHEAP_RESOURCE_TYPES,
        maxResources: Number(env.IAC_MAX_RESOURCES || DEFAULT_POLICY.maxResources),
        accounts: list(env.IAC_ACCOUNTS),
        regions: list(env.IAC_REGIONS).length ? list(env.IAC_REGIONS) : DEFAULT_POLICY.regions,
        permissionsBoundaryArn: env.IAC_BOUNDARY_ARN || undefined,
        substrateStacks: list(env.IAC_SUBSTRATE_STACKS).length ? list(env.IAC_SUBSTRATE_STACKS) : DEFAULT_POLICY.substrateStacks,
        allowNestedStacks: env.IAC_ALLOW_NESTED_STACKS === "true",
        allowTransforms: env.IAC_ALLOW_TRANSFORMS === "true",
    };
}
