/** Read only Lambda's final system record. Never persist or return the raw tail. */
export function lambdaRequestId(tail:string):string|undefined {
 for(const line of tail.split('\n').reverse()) {
  const id=/^(?:REPORT|END|START) RequestId:\s*([a-f0-9-]{36})\b/i.exec(line.trim())?.[1];
  if(id)return id;
  try{const row=JSON.parse(line);if(row.type==='platform.report'&&/^[a-f0-9-]{36}$/i.test(row.record?.requestId||''))return row.record.requestId;}catch{}
 }
 return undefined;
}
