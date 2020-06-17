import {Context} from "aws-lambda";
import {verify} from "jsonwebtoken";
import fetch from "node-fetch";
// Set in `environment` of serverless.yml
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;
const AUTH0_CLIENT_ID = process.env.AUTH0_CLIENT_ID;
const AUTH0_PUBLIC_KEY = process.env.AUTH0_PUBLIC_KEY;
const AUTH0_ISSUER = process.env.AUTH0_ISSUER;
const AUTH0_API = process.env.AUTH0_API;
const AUTH0_ALGORITHM = process.env.AUTH0_ALGORITHM;
class AuthService {
    generatePolicy(principalId: string, effect: string, resource: string) {
        const authResponse: any = {};
        authResponse.principalId = principalId;
        if (effect && resource) {
            const policyDocument: any = {};
            policyDocument.Version = "2012-10-17";
            policyDocument.Statement = [];
            const statementOne: any = {};
            statementOne.Action = "execute-api:Invoke";
            statementOne.Effect = effect;
            statementOne.Resource = resource;
            policyDocument.Statement[0] = statementOne;
            authResponse.policyDocument = policyDocument;
        }
        return authResponse;
    }
    userInfo(token: string, callback: (err: any, response: any) => void) {
        fetch(AUTH0_API + "userinfo", {
            method: "GET",
            headers: {
                Authorization: `Bearer ${token}`,
            }
        }).then((res) => {
            return res.json();
        }).then((json) => {
            callback(null, json);
        }).catch((err) => {
            callback(err, null);
        });
    }
    authHttpEvent(event: any, context: Context, callback: (err: any, response: any) => void) {
        if (!event.authorizationToken) {
            return callback("Unauthorized", null);
        }
        const tokenParts = event.authorizationToken.split(" ");
        const tokenValue = tokenParts[1];
        if (!(/bearer/i.test(tokenParts[0]) && tokenValue)) {
            console.info("authHttpEvent: unauthorized");
            return callback("Unauthorized", null);
        }
        this.auth(tokenValue, event.methodArn, callback);
    }
    auth(tokenValue: string, method: string, callback: (err: any, response: any) => void) {
        console.info("auth: begin");
        const options = {
            audience: AUTH0_AUDIENCE,
            issuer: AUTH0_ISSUER,
            algorithms: [AUTH0_ALGORITHM]
        }
        try {
            verify(tokenValue, AUTH0_PUBLIC_KEY, options, (err, decoded) => {
                if (err) {
                    console.info("auth: invalid token");
                    throw err;
                }
                console.info("auth: allow");
                callback(null, this.generatePolicy(decoded.sub, "Allow", method));
            });
        } catch (err) {
            console.info("auth: catch: " + err);
            return callback("Unauthorized", null);
        }
    }
}
export default AuthService;