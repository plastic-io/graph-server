import adapter from '@graph/auth-provider';
/** Authentication discovery/registration has no graph-service dependencies. */
export const handler = async (event: any) => adapter.oauthRequest ? adapter.oauthRequest(event)
    : {statusCode:404, headers:{'Content-Type':'application/json'}, body:'{"error":"not_found"}'};
