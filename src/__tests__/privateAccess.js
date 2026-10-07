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
});
