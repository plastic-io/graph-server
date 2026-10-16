const {ExecutionRunner,readObservations}=require('../runtime/executor');
const {executionRuntime}=require('../runtime/provenance');
const {isolationAvailable}=require('../runtime/isolate');
const fakeS3=require('../__testHelpers__/fakeS3'),FakeS3=fakeS3.FakeS3Service||fakeS3;
test('native containment loads and runtime evidence identifies instances without copying credentials',()=>{
 expect(isolationAvailable()).toBe(true);
 const before={...process.env};
 try{
  process.env.AWS_LAMBDA_FUNCTION_NAME='platform-readiness';process.env.AWS_LAMBDA_FUNCTION_VERSION='$LATEST';process.env.AWS_LAMBDA_LOG_STREAM_NAME='test-stream';process.env.AWS_SECRET_ACCESS_KEY='never-publish-this';
  const a=executionRuntime(),b=executionRuntime();
  expect(a).toMatchObject({functionName:'platform-readiness',functionVersion:'$LATEST',logStream:'test-stream',nodeAbi:process.versions.modules,containment:{available:true,version:'6.2.0'}});
  expect(b.instanceId).toBe(a.instanceId);expect(b.executionIndex).toBe(a.executionIndex+1);expect(b.initializedAt).toBe(a.initializedAt);
  expect(JSON.stringify(a)).not.toContain('never-publish-this');
 }finally{process.env=before;}
});
test('contained execution persists the same host provenance in results, observations and live bus',async()=>{
 const store=new FakeS3(),live=[],graph={id:'native-test',version:0,properties:{},nodes:[{id:'check',url:'check',edges:[],properties:{containment:'isolate',placement:'server',inputs:[{name:'in'}],outputs:[]},template:{set:'if (!host.contained || typeof process !== "undefined") throw new Error("Containment missing");',vue:''}}]};
 const result=await new ExecutionRunner(store,{live:o=>live.push(o)}).run({graph,nodeUrl:'check',field:'in',value:{},principal:{sub:'owner',kind:'human',tenant:'test'}});
 expect(result.errors).toBe(0);expect(result.runtime.containment.available).toBe(true);
 const record=JSON.parse(store.objects.get(ExecutionRunner.executionKey(result.executionId)).toString());
 expect(record.runtime).toEqual(result.runtime);
 const observations=await readObservations(store,record);
 expect(observations.find(o=>o.kind==='exec.begin').payload.runtime).toEqual(result.runtime);
 expect(live.find(o=>o.kind==='exec.begin').payload.runtime).toEqual(result.runtime);
});
