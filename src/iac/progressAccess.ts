import {decide} from '../policy/decide';
export function progressAllowed(principal:any,event:any) {
 if(!decide(principal,['graph:read','iac:read-status']).allow)return false;
 return event?.kind!=='deployment.runtime-log'||decide(principal,['graph:observe','graph:inspect-payloads']).allow;
}
