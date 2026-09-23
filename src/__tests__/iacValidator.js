const { validateTemplate, validateDesired, policyFromEnv } = require("../iac/validator");

/**
 * What a template is allowed to be (plan §4.9.6, PB-091).
 *
 * Every test here is an escalation class: a way to run code, hand out
 * authority, or reach a resource this environment does not own.  The IAM
 * boundary stops the damage; this stops the attempt, earlier, where the answer
 * can name the resource and a person reviewing a proposal can read it.
 */

const policy = {
    stackPrefix: "pio-dev-",
    accounts: ["695527765921"],
    regions: ["us-west-1"],
    permissionsBoundaryArn: "arn:aws:iam::695527765921:policy/pio-dev-boundary",
    substrateStacks: ["plastic-io-graph-server", "plastic-io-iac-orchestrator"],
};
const codes = (r) => r.problems.map((p) => p.code).sort();

const GOOD = `AWSTemplateFormatVersion: "2010-09-09"
Description: a bucket and the role that reads it
Parameters:
  Stage:
    Type: String
    Default: dev
Resources:
  Bucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Sub "pio-dev-\${Stage}-uploads"
  Reader:
    Type: AWS::IAM::Role
    Properties:
      RoleName: pio-dev-reader
      PermissionsBoundary: arn:aws:iam::695527765921:policy/pio-dev-boundary
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal: {Service: lambda.amazonaws.com}
            Action: sts:AssumeRole
      Policies:
        - PolicyName: read
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: [s3:GetObject]
                Resource: !Sub "\${Bucket.Arn}/*"
Outputs:
  BucketName:
    Value: !Ref Bucket
`;

describe("a template that is allowed", () => {
    test("reads the ordinary CloudFormation a person would write, short tags and all", () => {
        const r = validateTemplate(GOOD, "yaml", policy);
        expect(r.problems).toEqual([]);
        expect(r.ok).toBe(true);
        expect(r.counts).toEqual({ resources: 2, outputs: 1, parameters: 1 });
        expect(r.resourceTypes).toEqual(["AWS::IAM::Role", "AWS::S3::Bucket"]);
        // the digest is what addresses the artifact, so it has to be of the bytes as given
        expect(r.templateSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(validateTemplate(GOOD, "yaml", policy).templateSha256).toBe(r.templateSha256);
    });

    test("a name left to the deployment to resolve is not judged here", () => {
        // !Sub and !Ref names are enforced by IAM, which sees the resolved value
        const r = validateTemplate(GOOD.replace('BucketName: !Sub "pio-dev-${Stage}-uploads"', "BucketName: !Ref Stage"), "yaml", policy);
        expect(r.ok).toBe(true);
    });

    test("JSON is read as JSON", () => {
        const json = JSON.stringify({ Resources: { Bucket: { Type: "AWS::S3::Bucket", Properties: { BucketName: "pio-dev-x" } } } });
        expect(validateTemplate(json, "json", policy).ok).toBe(true);
        // and the same bytes read as YAML are still a template, because JSON is YAML
        expect(validateTemplate(json, "yaml", policy).ok).toBe(true);
    });
});

describe("ways to run code, which are refused", () => {
    test("a custom resource", () => {
        const t = `Resources:\n  Thing:\n    Type: Custom::Deployer\n    Properties:\n      ServiceToken: arn:aws:lambda:us-west-1:695527765921:function:whatever\n`;
        const r = validateTemplate(t, "yaml", policy);
        expect(codes(r)).toEqual(["CUSTOM_RESOURCE"]);
        expect(r.problems[0].resource).toBe("Thing");
        expect(r.problems[0].message).toMatch(/with this deployment's authority/);
    });

    test("the long form of the same thing", () => {
        const t = `Resources:\n  Thing:\n    Type: AWS::CloudFormation::CustomResource\n    Properties: {ServiceToken: x}\n`;
        expect(codes(validateTemplate(t, "yaml", policy))).toEqual(["CUSTOM_RESOURCE"]);
    });

    test("a transform, at the top or in the middle", () => {
        const top = `Transform: AWS::Serverless-2016-10-31\nResources:\n  B:\n    Type: AWS::S3::Bucket\n`;
        expect(codes(validateTemplate(top, "yaml", policy))).toEqual(["TRANSFORM"]);
        const inner = `Resources:\n  B:\n    Type: AWS::S3::Bucket\n    Properties:\n      Fn::Transform: {Name: Include, Parameters: {Location: s3://somewhere/else.yaml}}\n`;
        expect(codes(validateTemplate(inner, "yaml", policy))).toEqual(["TRANSFORM"]);
    });

    test("a macro definition", () => {
        const t = `Resources:\n  M:\n    Type: AWS::CloudFormation::Macro\n    Properties: {Name: rewrite, FunctionName: f}\n`;
        expect(codes(validateTemplate(t, "yaml", policy))).toEqual(["MACRO"]);
    });

    test("a nested stack, which is a template nobody validated", () => {
        const t = `Resources:\n  Inner:\n    Type: AWS::CloudFormation::Stack\n    Properties: {TemplateURL: "https://example.com/t.yaml"}\n`;
        expect(codes(validateTemplate(t, "yaml", policy))).toEqual(["NESTED_STACK"]);
        // and an environment may allow it deliberately
        expect(validateTemplate(t, "yaml", { ...policy, allowNestedStacks: true }).ok).toBe(true);
    });
});

describe("ways to hand out authority, which are refused", () => {
    test("a role without the permissions boundary", () => {
        const t = `Resources:\n  R:\n    Type: AWS::IAM::Role\n    Properties:\n      RoleName: pio-dev-r\n      AssumeRolePolicyDocument: {Version: "2012-10-17", Statement: []}\n`;
        const r = validateTemplate(t, "yaml", policy);
        expect(codes(r)).toEqual(["IAM_WITHOUT_BOUNDARY"]);
        expect(r.problems[0].path).toBe("Resources.R.Properties.PermissionsBoundary");
    });

    test("a boundary that is not the one this environment requires", () => {
        const t = `Resources:\n  R:\n    Type: AWS::IAM::Role\n    Properties:\n      RoleName: pio-dev-r\n      PermissionsBoundary: arn:aws:iam::695527765921:policy/something-else\n      AssumeRolePolicyDocument: {Version: "2012-10-17", Statement: []}\n`;
        expect(codes(validateTemplate(t, "yaml", policy))).toEqual(["IAM_WITHOUT_BOUNDARY"]);
    });

    test("a statement that grants everything except what it lists", () => {
        const t = `Resources:\n  P:\n    Type: AWS::IAM::ManagedPolicy\n    Properties:\n      ManagedPolicyName: pio-dev-p\n      PolicyDocument:\n        Statement:\n          - Effect: Allow\n            NotAction: [iam:*]\n            Resource: "*"\n`;
        expect(codes(validateTemplate(t, "yaml", policy))).toEqual(["IAM_NEGATED_STATEMENT"]);
    });

    test("a resource handed to everybody", () => {
        const t = `Resources:\n  Policy:\n    Type: AWS::S3::BucketPolicy\n    Properties:\n      Bucket: pio-dev-b\n      PolicyDocument:\n        Statement:\n          - Effect: Allow\n            Principal: "*"\n            Action: s3:GetObject\n            Resource: "arn:aws:s3:::pio-dev-b/*"\n`;
        expect(codes(validateTemplate(t, "yaml", policy))).toEqual(["OPEN_PRINCIPAL"]);
    });

    test("a resource handed to another account", () => {
        const t = `Resources:\n  Policy:\n    Type: AWS::S3::BucketPolicy\n    Properties:\n      Bucket: pio-dev-b\n      PolicyDocument:\n        Statement:\n          - Effect: Allow\n            Principal: {AWS: "arn:aws:iam::111122223333:root"}\n            Action: s3:GetObject\n            Resource: "arn:aws:s3:::pio-dev-b/*"\n`;
        const r = validateTemplate(t, "yaml", policy);
        expect(codes(r)).toEqual(["FOREIGN_PRINCIPAL"]);
        expect(r.problems[0].message).toMatch(/111122223333/);
        // the account this environment owns is not foreign
        const own = t.replace("111122223333", "695527765921");
        expect(validateTemplate(own, "yaml", policy).ok).toBe(true);
    });

    test("a deny statement naming everybody is not a grant", () => {
        const t = `Resources:\n  Policy:\n    Type: AWS::S3::BucketPolicy\n    Properties:\n      Bucket: pio-dev-b\n      PolicyDocument:\n        Statement:\n          - Effect: Deny\n            Principal: "*"\n            Action: s3:*\n            Resource: "arn:aws:s3:::pio-dev-b/*"\n            Condition: {Bool: {"aws:SecureTransport": "false"}}\n`;
        expect(validateTemplate(t, "yaml", policy).ok).toBe(true);
    });
});

describe("ways to reach what this environment does not own", () => {
    test("a name outside the prefix", () => {
        const t = `Resources:\n  B:\n    Type: AWS::S3::Bucket\n    Properties: {BucketName: somebody-elses-bucket}\n`;
        const r = validateTemplate(t, "yaml", policy);
        expect(codes(r)).toEqual(["NAME_OUTSIDE_PREFIX"]);
        expect(r.problems[0].message).toMatch(/pio-dev-/);
    });

    test("the substrate this server runs on", () => {
        const t = `Resources:\n  B:\n    Type: AWS::S3::Bucket\n    Properties: {BucketName: plastic-io-graph-server}\n`;
        expect(codes(validateTemplate(t, "yaml", policy))).toEqual(["NAME_OUTSIDE_PREFIX", "SUBSTRATE_TARGET"]);
    });

    test("a credential written into the template", () => {
        const t = `Resources:\n  F:\n    Type: AWS::Lambda::Function\n    Properties:\n      FunctionName: pio-dev-f\n      Environment:\n        Variables:\n          KEY: AKIAIOSFODNN7EXAMPLE\n`;
        expect(codes(validateTemplate(t, "yaml", policy))).toEqual(["EMBEDDED_CREDENTIAL"]);
    });
});

describe("a template that cannot be read is not a template", () => {
    test("unreadable yaml says so rather than passing", () => {
        const r = validateTemplate("Resources:\n  - [unbalanced\n", "yaml", policy);
        expect(r.ok).toBe(false);
        expect(r.problems[0].code).toBe("TEMPLATE_UNREADABLE");
    });

    test("no resources deploys nothing", () => {
        expect(codes(validateTemplate("Description: hello\n", "yaml", policy))).toEqual(["TEMPLATE_EMPTY"]);
    });

    test("a resource with no type", () => {
        expect(codes(validateTemplate("Resources:\n  B: {Properties: {}}\n", "yaml", policy))).toEqual(["RESOURCE_SHAPE"]);
    });
});

describe("the desired state", () => {
    const ULID = "01J8ZK5K0B1C2D3E4F5G6H7J8A";
    const desired = () => ({
        schemaVersion: 1,
        stack: { name: "pio-dev-uploads", account: "695527765921", region: "us-west-1", environment: "dev" },
        template: { artifactRef: { graphId: "g1", nodeId: "n1", revisionId: "rev_01J8ZK5K0B1C2D3E4F5G6H7J8A", sha256: "a".repeat(64) }, format: "yaml" },
        parameters: { Stage: "dev" },
        capabilities: ["CAPABILITY_NAMED_IAM"],
        operation: "plan",
        trigger: { kind: "explicit" },
        correlation: { idempotencyKey: ULID },
    });

    test("a whole one passes and comes back", () => {
        const r = validateDesired(desired(), policy);
        expect(r.problems).toEqual([]);
        expect(r.desired.stack.name).toBe("pio-dev-uploads");
    });

    test("a stack outside the prefix, in the wrong account, in the wrong region", () => {
        const r = validateDesired({ ...desired(), stack: { name: "prod-database", account: "111122223333", region: "eu-west-1", environment: "prod" } }, policy);
        expect(codes(r)).toEqual(["ACCOUNT_NOT_ALLOWED", "REGION_NOT_ALLOWED", "STACK_PREFIX"]);
    });

    test("the substrate is never a target", () => {
        const r = validateDesired({ ...desired(), stack: { ...desired().stack, name: "plastic-io-graph-server" } }, { ...policy, stackPrefix: "plastic-io-" });
        expect(codes(r)).toEqual(["SUBSTRATE_TARGET"]);
    });

    test("a secret does not travel as a parameter", () => {
        const r = validateDesired({ ...desired(), parameters: { ApiKey: { secretRef: "openai" } } }, policy);
        expect(codes(r)).toEqual(["SECRET_PARAMETER"]);
        expect(r.problems[0].message).toMatch(/dynamic reference/);
    });

    test("consent for macros is consent for code", () => {
        const r = validateDesired({ ...desired(), capabilities: ["CAPABILITY_AUTO_EXPAND"] }, policy);
        expect(codes(r)).toEqual(["TRANSFORM"]);
    });

    test("what this milestone cannot do, it says it cannot do", () => {
        const r = validateDesired({ ...desired(), operation: "apply" }, policy);
        expect(codes(r)).toEqual(["UNSUPPORTED_OPERATION"]);
        expect(r.problems[0].message).toMatch(/orchestrator/);
    });

    test("a field nothing reads is refused rather than ignored", () => {
        const r = validateDesired({ ...desired(), roleArn: "arn:aws:iam::695527765921:role/anything" }, policy);
        expect(codes(r)).toEqual(["UNKNOWN_FIELD"]);
    });

    test("a retry needs a key that makes it the same request", () => {
        const r = validateDesired({ ...desired(), correlation: { idempotencyKey: "whenever" } }, policy);
        expect(codes(r)).toEqual(["SCHEMA_INVALID"]);
    });
});

describe("the policy is substrate configuration, not graph content", () => {
    test("it comes from the environment, with safe defaults", () => {
        const p = policyFromEnv({ IAC_STACK_PREFIX: "pio-test-", IAC_ACCOUNTS: "1,2 , 3", IAC_REGIONS: "us-east-2", IAC_BOUNDARY_ARN: "arn:boundary" });
        expect(p).toMatchObject({ stackPrefix: "pio-test-", accounts: ["1", "2", "3"], regions: ["us-east-2"], permissionsBoundaryArn: "arn:boundary" });
        expect(p.allowNestedStacks).toBe(false);
        expect(p.allowTransforms).toBe(false);
        expect(p.substrateStacks).toContain("plastic-io-graph-server");
    });

    test("with nothing configured it still refuses the substrate and still has a prefix", () => {
        const p = policyFromEnv({});
        expect(p.stackPrefix).toBe("pio-dev-");
        expect(p.substrateStacks.length).toBeGreaterThan(0);
    });
});

describe("what it would cost to leave running", () => {
    /**
     * This runs in somebody's personal account.  The IAM boundary stops a
     * template doing damage; none of it stops a template being expensive, and
     * an idle NAT gateway costs more per month than everything else here put
     * together.  So the resource types are an allow-list — absence is refusal —
     * and the few things inside it that can be made to bill while idle are
     * checked one by one.
     */
    const { DEFAULT_POLICY, CHEAP_RESOURCE_TYPES } = require("../iac/types");
    const strict = { ...policy, allowedResourceTypes: CHEAP_RESOURCE_TYPES, maxResources: 100 };

    test("the cheap things are allowed", () => {
        const t = `Resources:\n  B:\n    Type: AWS::S3::Bucket\n    Properties: {BucketName: pio-dev-b}\n  Q:\n    Type: AWS::SQS::Queue\n    Properties: {QueueName: pio-dev-q}\n  F:\n    Type: AWS::Lambda::Function\n    Properties: {FunctionName: pio-dev-f}\n`;
        expect(validateTemplate(t, "yaml", strict).ok).toBe(true);
    });

    test("anything with an hourly price is not on the list, and absence is refusal", () => {
        for (const type of ["AWS::EC2::Instance", "AWS::EC2::NatGateway", "AWS::RDS::DBInstance", "AWS::ElastiCache::CacheCluster", "AWS::EKS::Cluster", "AWS::OpenSearchService::Domain", "AWS::Kinesis::Stream", "AWS::ECS::Service", "AWS::EC2::EIP"]) {
            const t = `Resources:\n  X:\n    Type: ${type}\n    Properties: {}\n`;
            const r = validateTemplate(t, "yaml", strict);
            expect(codes(r)).toContain("RESOURCE_TYPE_NOT_ALLOWED");
            expect(r.problems[0].message).toMatch(/costs nothing while it sits idle/);
        }
    });

    test("an environment can widen the list deliberately", () => {
        const t = `Resources:\n  X:\n    Type: AWS::EC2::Instance\n    Properties: {}\n`;
        expect(validateTemplate(t, "yaml", { ...strict, allowedResourceTypes: [...CHEAP_RESOURCE_TYPES, "AWS::EC2::Instance"] }).ok).toBe(true);
    });

    test("a table billed by capacity rather than by use", () => {
        const provisioned = `Resources:\n  T:\n    Type: AWS::DynamoDB::Table\n    Properties:\n      TableName: pio-dev-t\n      ProvisionedThroughput: {ReadCapacityUnits: 5, WriteCapacityUnits: 5}\n`;
        expect(codes(validateTemplate(provisioned, "yaml", strict))).toEqual(["COST_PROVISIONED"]);
        const onDemand = `Resources:\n  T:\n    Type: AWS::DynamoDB::Table\n    Properties:\n      TableName: pio-dev-t\n      BillingMode: PAY_PER_REQUEST\n`;
        expect(validateTemplate(onDemand, "yaml", strict).ok).toBe(true);
    });

    test("concurrency reserved in advance is billed in advance", () => {
        const t = `Resources:\n  V:\n    Type: AWS::Lambda::Version\n    Properties:\n      FunctionName: pio-dev-f\n      ProvisionedConcurrencyConfig: {ProvisionedConcurrentExecutions: 2}\n`;
        expect(codes(validateTemplate(t, "yaml", strict))).toEqual(["COST_PROVISIONED"]);
    });

    test("logs kept for ever are the part of logging that keeps costing", () => {
        const forever = `Resources:\n  L:\n    Type: AWS::Logs::LogGroup\n    Properties: {LogGroupName: pio-dev-l}\n`;
        expect(codes(validateTemplate(forever, "yaml", strict))).toEqual(["COST_UNBOUNDED"]);
        const bounded = `Resources:\n  L:\n    Type: AWS::Logs::LogGroup\n    Properties: {LogGroupName: pio-dev-l, RetentionInDays: 14}\n`;
        expect(validateTemplate(bounded, "yaml", strict).ok).toBe(true);
    });

    test("a template with more resources than the environment deploys is refused unread", () => {
        const many = "Resources:\n" + Array.from({ length: 101 }, (_, i) => `  B${i}:\n    Type: AWS::S3::Bucket\n    Properties: {BucketName: pio-dev-b${i}}\n`).join("");
        const r = validateTemplate(many, "yaml", strict);
        expect(codes(r)).toEqual(["TOO_MANY_RESOURCES"]);
        expect(r.counts.resources).toBe(101);
    });

    test("the default policy is the careful one, whatever the environment says", () => {
        expect(DEFAULT_POLICY.allowedResourceTypes).toBe(CHEAP_RESOURCE_TYPES);
        expect(DEFAULT_POLICY.maxResources).toBe(100);
        expect(policyFromEnv({}).allowedResourceTypes).toEqual(CHEAP_RESOURCE_TYPES);
        expect(policyFromEnv({ IAC_ALLOWED_TYPES: "AWS::S3::Bucket" }).allowedResourceTypes).toEqual(["AWS::S3::Bucket"]);
        expect(policyFromEnv({ IAC_MAX_RESOURCES: "5" }).maxResources).toBe(5);
    });
});
