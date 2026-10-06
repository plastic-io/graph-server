/** Compatibility entry for existing Auth0 callers. Production uses the selected adapter. */
export { configFromEnv, JwtConfig } from "./providers/auth0";
import { createAdapter, JwtConfig } from "./providers/auth0";
export async function verifyBearer(token: string, config?: JwtConfig) {
    return (await createAdapter(config).verifyAccessToken(token)).principal;
}
