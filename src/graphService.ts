import {Context, S3CreateEvent, APIGatewayEvent, APIGatewayEventRequestContext} from "aws-lambda";
/** Watches for changes to the job bucket and logs them to cloudwatch */
class GraphService {
    constructor() {}
    defaultRoute(event: any, context: Context) {
        console.log("defaultRoute", event);
    }
}
export default GraphService;
