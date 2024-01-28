import Scheduler, {Node, Graph} from "@plastic-io/plastic-io";
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');

class GraphExecutionService {
  worker: any;
  constructor(
    public graph: Graph,
    public nodeUrl: string,
    public value: any,
    public field: string,
    public send: (msg: any) => Promise<void>,
  ) {}
  public async init() {
    this.worker = new Worker(__filename, {
      workerData: {
        graph: this.graph,
        nodeUrl: this.nodeUrl,
        value: this.value,
        field: this.field,
      },
    });
    this.worker.on("message", async (msg) => {
      await this.send(msg);
    });
    this.worker.on("error", (msg) => {});
    this.worker.on("exit", (msg) => {});
  }
  public async route() {
    // route body
  }
}

if (!isMainThread) {
    const parsedData = JSON.parse(workerData);
    console.log("worker: starting router");
    const send = async (message: any): Promise<void> => {
      parentPort.postMessage(message);
    };
    const svc = new GraphExecutionService(parsedData.graph,
      parsedData.nodeUrl,
      parsedData.field,
      parsedData.value,
      send);
    svc.route().then(() => {
      console.log("worker: ending");
      send({type: 'worker', message: 'Worker ending'});
    }).catch((err) => {
      send({type: 'worker', message: 'Worker error ' + err, error: err});
      console.log("worker: ending router with error", err);
    });
}
