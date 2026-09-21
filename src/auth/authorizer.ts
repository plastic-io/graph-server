import { extractToken } from "./principal";
import { verifyBearer, JwtConfig, configFromEnv } from "./jwt";

/**
 * Lambda REQUEST authorizer shared by the REST API (Authorization: Bearer) and the
 * WebSocket $connect route (Sec-WebSocket-Protocol: access_token, <jwt>).  Throwing
 * "Unauthorized" makes API Gateway answer 401; any other failure is a 500.
 */
export async function authorize(event: any, config: JwtConfig = configFromEnv()) {
    const token = extractToken(event);
    if (!token) {
        throw new Error("Unauthorized");
    }
    let principal;
    try {
        principal = await verifyBearer(token, config);
    } catch (err) {
        console.error("Rejected token:", (err && err.message) || err);
        throw new Error("Unauthorized");
    }
    return {
        principalId: principal.sub,
        policyDocument: {
            Version: "2012-10-17",
            Statement: [{ Action: "execute-api:Invoke", Effect: "Allow", Resource: stageResource(event.methodArn) }],
        },
        // API Gateway only carries strings/numbers/booleans here; lists travel as JSON.
        context: {
            sub: principal.sub,
            kind: principal.kind,
            tenant: principal.tenant,
            email: principal.email || "",
            name: principal.name || "",
            scopes: JSON.stringify(principal.scopes),
        },
    };
}

/** arn:aws:execute-api:region:account:apiId/stage/METHOD/path -> the whole stage, so a cached decision covers every route. */
export function stageResource(methodArn: string): string {
    const parts = String(methodArn || "").split(":");
    if (parts.length < 6) {
        return methodArn;
    }
    const [apiId, stage] = parts[5].split("/");
    return `${parts.slice(0, 5).join(":")}:${apiId}/${stage}/*`;
}
