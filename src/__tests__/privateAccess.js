const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const read = file => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
const service = YAML.parse(read('serverless.yaml'), {logLevel:'silent'});
const identity = YAML.parse(read('infra/auth-environment.yaml'), {logLevel:'silent'});
const handlers = read('src/handler.ts');

// These checks protect the deployment boundary, where forgetting an authorizer
// on just one new route would bypass otherwise-correct token verification.
describe('private deployment access boundaries', () => {
  test('every HTTP data or execution route has the JWT authorizer; only authentication routes are public', () => {
    const publicRoutes = [];
    for (const [name, fn] of Object.entries(service.functions)) {
      for (const event of fn.events || []) {
        if (!event.http) continue;
        const route = event.http;
        if (name === 'protectedResourceMetadata') {
          publicRoutes.push([String(route.method).toUpperCase(),route.path]);
        } else {
          expect({name, authorizer:route.authorizer}).toEqual({name,authorizer:'${self:custom.jwtAuthorizer}'});
          const handler = fn.handler.split('.').pop();
          expect(handlers).toMatch(new RegExp(`const ${handler} = withPrincipal\\(`));
        }
      }
    }
    expect(publicRoutes).toEqual([['GET','/.well-known/oauth-protected-resource']]);
    const registrationRole = service.resources.Resources.CognitoMcpRegistrationRole.Properties;
    expect(registrationRole.Policies[0].PolicyDocument.Statement.map(s=>s.Action)).toEqual([
      ['dynamodb:GetItem','dynamodb:PutItem','dynamodb:UpdateItem'],
      ['cognito-idp:CreateUserPoolClient','cognito-idp:CreateManagedLoginBranding'],
      ['logs:CreateLogStream','logs:PutLogEvents'],
    ]);
    expect(read('src/oauthHandler.ts')).not.toMatch(/graphService|eventSourceService|mcp\/handler/);
    const resourceServer=service.resources.Resources.CognitoMcpResourceServer;
    expect(resourceServer.Condition).toBe('CognitoMcpEnabled');
    expect(resourceServer.Properties.Identifier).toBe('https://${ApiGatewayRestApi}.execute-api.${AWS::Region}.amazonaws.com/${self:provider.stage}/mcp');
    expect(resourceServer.Properties.Scopes.map(scope=>scope.ScopeName)).toEqual(['access','read','propose']);
    expect(service.custom.jwtAuthorizer.resultTtlInSeconds).toBe(0);
  });
  test('WebSocket connect authenticates and every later client route resolves a server principal', () => {
    for (const fn of Object.values(service.functions)) {
      for (const event of fn.events || []) {
        if (!event.websocket || event.websocket.route === '$disconnect') continue;
        if (event.websocket.route === '$connect') expect(event.websocket.authorizer).toBeTruthy();
        const handler = fn.handler.split('.').pop();
        expect(handlers).toMatch(new RegExp(`const ${handler} = withPrincipal\\(`));
      }
    }
  });
  test('Function URLs only serve verified MCP requests or the isolated registration service', () => {
    const resources = service.resources.Resources;
    const urls = Object.entries(resources).filter(([,r]) => r.Type === 'AWS::Lambda::Url');
    expect(urls.map(([name])=>name)).toEqual(['CognitoMcpOAuthUrl','McpStreamUrl']);
    expect(service.functions.mcpStream.handler).toBe('src/handler.mcpStream');
    expect(resources.McpStreamInvokePermission.Properties.InvokedViaFunctionUrl).toBe(true);
    expect(resources.McpStreamUrlPermission.Properties.FunctionUrlAuthType).toBe('NONE');
    expect(resources.CognitoMcpOAuthInvokePermission.Properties.InvokedViaFunctionUrl).toBe(true);
    expect(resources.CognitoMcpOAuthUrlPermission.Properties.FunctionUrlAuthType).toBe('NONE');
    expect(resources.CognitoMcpOAuthUrl.Condition).toBe('CognitoMcpEnabled');
    // Signature, expiry, issuer, client, token-use and scope enforcement at this
    // URL are exercised by cognitoAuth.js and the streaming transport tests.
  });
  test('graph storage stays private and Cognito self-signup stays disabled', () => {
    expect(service.resources.Resources.StaticSite.Properties.AccessControl).toBe('Private');
    expect(service.resources.Resources.StaticSite.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true,
    });
    expect(identity.Resources.UserPool.Properties.AdminCreateUserConfig.AllowAdminCreateUserOnly).toBe(true);
    expect(identity.Resources.UserPoolDomain.Properties.ManagedLoginVersion).toBe(2);
    expect(identity.Resources.BrowserLoginBranding.Properties.UseCognitoProvidedValues).toBe(true);
    expect(identity.Resources.EditorBucket.Properties.PublicAccessBlockConfiguration).toEqual({
      BlockPublicAcls:true,IgnorePublicAcls:true,BlockPublicPolicy:true,RestrictPublicBuckets:true,
    });
  });
  test('every synchronous execution entry point has containment and the bridge has no public route',()=>{
    expect(service.provider.environment.REQUIRE_CONTAINMENT).toBe('true');
    // YAML's generic parser preserves !Ref as its scalar value, while the
    // equivalent long form remains {Ref: ...}.
    for(const name of ['mcpRoute','mcpStream','edgeDeliver','taskWorker','revisionActivate','publish','default','httpDefault'])expect(service.functions[name].layers.map(layer=>layer.Ref||layer)).toContain('IsolatedVmLambdaLayer');
    expect(service.functions.applicationBridge.events).toBeUndefined();
    const role=JSON.stringify(service.resources.Resources.ApplicationBridgeRole);
    expect(role).not.toContain('iam:PassRole');expect(role).not.toContain('states:StartExecution');
    expect(role).toContain('function:gapp-*');
  });
  test('only the isolated infrastructure worker can execute a reviewed change set',()=>{
    const shared=JSON.stringify(service.provider.iamRoleStatements);
    expect(shared).not.toContain('cloudformation:ExecuteChangeSet');
    expect(shared).not.toContain('iam:PassRole');
    expect(service.functions.iacWorker.events).toBeUndefined();
    expect(service.functions.iacWorker.handler).toBe('src/iacWorker.handler');
    const worker=service.resources.Resources.IacWorkerRole.Properties.Policies[0].PolicyDocument.Statement;
    expect(worker.some(s=>s.Action.includes('cloudformation:ExecuteChangeSet'))).toBe(true);
    expect(worker.find(s=>s.Action==='iam:PassRole').Condition.StringEquals['iam:PassedToService']).toBe('cloudformation.amazonaws.com');
    const execution=JSON.stringify(service.resources.Resources.IacExecutionRole);
    expect(execution).not.toMatch(/iam:PassRole|lambda:InvokeFunction|iam:CreateRole|cloudformation:ExecuteChangeSet/);
    const machine=service.resources.Resources.IacReviewStateMachine.Properties;
    expect(machine.StateMachineType).toBe('STANDARD');
    expect(machine.Definition.States.Wait.Type).toBe('Wait');
  });
  test('diagnostics have private read-only AWS access and cannot change application or deployment permissions',()=>{
    const resources=service.resources.Resources,role=resources.IacDiagnosticsRole.Properties;
    expect(service.functions.iacDiagnostics.events).toBeUndefined();
    const statements=role.Policies.flatMap(p=>p.PolicyDocument.Statement),actions=statements.flatMap(s=>[].concat(s.Action));
    expect(actions.filter(a=>/^(iam|sts|lambda):/.test(a))).toEqual([]);
    expect(actions.filter(a=>a.startsWith('cloudformation:')).sort()).toEqual(['cloudformation:DescribeChangeSet','cloudformation:DescribeStackEvents','cloudformation:DescribeStacks']);
    const logs=statements.find(s=>s.Action==='logs:FilterLogEvents');
    expect(JSON.stringify(logs.Resource)).toContain('-iacWorker:*');expect(JSON.stringify(logs.Resource)).not.toContain('gapp-');expect(actions).not.toContain('logs:Unmask');
    const writes=statements.filter(s=>[].concat(s.Action).includes('s3:PutObject'));
    expect(writes.flatMap(s=>s.Resource).every(r=>/iac\/progress|observations\/watch/.test(JSON.stringify(r)))).toBe(true);
    const listing=statements.find(s=>s.Action==='s3:ListBucket');
    expect(listing.Condition.StringLike['s3:prefix']).toEqual(['subscriptions/graph-notify-*','iac/progress/*','observations/watch/*']);
    const rule=resources.IacDiagnosticWorkflowEvents.Properties;
    expect(rule.EventPattern.detail.status).toEqual(['FAILED','TIMED_OUT','ABORTED','SUCCEEDED']);
    expect(rule.EventPattern.detail.stateMachineArn).toEqual(['IacReviewStateMachine']);
    const guard=resources.IacGuardrailRole.Properties.Policies.flatMap(p=>p.PolicyDocument.Statement);
    const absentRoleProbe=guard.find(s=>[].concat(s.Resource).some(r=>String(r).endsWith(':role/gapp-*')));
    expect(absentRoleProbe.Action).toEqual(['iam:GetRole','iam:GetRolePolicy','iam:DeleteRolePolicy']);
    expect(guard.filter(s=>s!==absentRoleProbe&&[].concat(s.Action).some(a=>/^iam:(CreateRole|DeleteRole|DeleteRolePolicy|PutRolePolicy)$/.test(a))).every(s=>JSON.stringify(s.Resource).includes('role/graph-deploy/gapp-'))).toBe(true);
    expect(absentRoleProbe.Action).not.toContain('iam:CreateRole');expect(absentRoleProbe.Action).not.toContain('iam:PutRolePolicy');
  });
  test('guardrail reconciliation is private, cannot forge approvals or change shared IAM, and adds no workflow dependency cycle',()=>{
    expect(service.functions.iacGuardrailRepair.events).toBeUndefined();expect(service.functions.iacGuardrailRepair.url).toBeUndefined();
    const statements=service.resources.Resources.IacGuardrailRepairRole.Properties.Policies.flatMap(p=>p.PolicyDocument.Statement),actions=statements.flatMap(s=>[].concat(s.Action));
    for(const action of ['s3:PutObject','iam:PassRole','iam:CreateRole','iam:DeleteRole','iam:DeleteRolePermissionsBoundary','lambda:InvokeFunction','logs:Unmask'])expect(actions).not.toContain(action);
    const writes=statements.filter(s=>[].concat(s.Action).some(a=>/^iam:(Put|Update|Create|Delete)/.test(a)));
    expect(writes).toHaveLength(2);expect(writes.every(s=>/role\/graph-deploy\/gapp-|policy\/graph-guardrails\/gapp-/.test(JSON.stringify(s.Resource)))).toBe(true);
    const workflow=JSON.stringify(service.functions.iacWorker.environment.IAC_REVIEW_STATE_MACHINE);
    expect(workflow).toContain(':stateMachine:');expect(workflow).not.toContain('IacReviewStateMachine');
  });
});
