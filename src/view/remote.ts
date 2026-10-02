import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { Renderer, ShotRequest, ShotResult } from "./capture";

/**
 * The browser, from the function that wanted the picture (PB-149).
 *
 * Chromium lives in another function, so this is how the server asks for a
 * picture: one invocation, the request in, the image out.  The request carries
 * the caller's bearer so the page renders as them — it crosses between two
 * functions of the same deployment over the AWS API, and is never written to a
 * log on either side.
 */
export class LambdaRenderer implements Renderer {
    private lambda: LambdaClient;
    constructor(private functionName: string, region: string) {
        this.lambda = new LambdaClient({ region });
    }

    async shoot(request: ShotRequest): Promise<ShotResult> {
        const answer = await this.lambda.send(new InvokeCommand({
            FunctionName: this.functionName,
            Payload: Buffer.from(JSON.stringify(request)),
        }));
        if (!answer.Payload) {
            throw new Error("the browser answered with nothing");
        }
        const body = JSON.parse(Buffer.from(answer.Payload).toString("utf8"));
        if (!body || body.error || body.errorMessage) {
            throw new Error(String(body && (body.error || body.errorMessage) || "the browser failed and said nothing"));
        }
        return {
            image: Buffer.from(String(body.image || ""), "base64"),
            format: body.format === "jpeg" ? "jpeg" : "png",
            title: body.title,
            status: body.status,
            console: body.console,
        };
    }
}
