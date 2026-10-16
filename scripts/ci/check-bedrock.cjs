// Read-only CI preflight, before packaging or enabling the assistant. No chat
// content or credentials are sent. Live inference is a separate release check.
const {execFileSync} = require('node:child_process');
function verify(profile, availability, env) {
  const model = env.BEDROCK_MODEL_ID || 'us.anthropic.claude-opus-5-5';
  const foundation = model.slice(3), account = env.AWS_ACCOUNT_ID, region = env.AWS_REGION;
  const expected = `arn:aws:bedrock:${region}:${account}:inference-profile/${model}`;
  if (profile.inferenceProfileArn !== expected || profile.status !== 'ACTIVE') throw new Error('Requested Bedrock inference profile is not active in this account and region');
  const regions = ['us-east-1','us-east-2','us-west-1','us-west-2'];
  if (!profile.models?.length || profile.models.some(m => !regions.some(r => m.modelArn === `arn:aws:bedrock:${r}::foundation-model/${foundation}`))) throw new Error('Bedrock routing does not match the narrowly scoped worker role');
  if (availability.authorizationStatus !== 'AUTHORIZED' || availability.entitlementAvailability !== 'AVAILABLE' || availability.agreementAvailability?.status !== 'AVAILABLE' || availability.regionAvailability !== 'AVAILABLE') throw new Error('The account needs Bedrock Opus model access before enabling the assistant');
  return {model, regions: profile.models.map(m => m.modelArn.split(':')[3]), verification: 'Availability and routing only; invoke a synthetic turn after release to verify execution.'};
}
if (require.main === module && process.env.BEDROCK_AGENT_ENABLED === 'true') {
  const model = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-opus-5-5';
  const read = (operation, args) => JSON.parse(execFileSync('aws', ['bedrock', operation, ...args, '--region', process.env.AWS_REGION, '--output', 'json'], {encoding: 'utf8'}));
  console.log(JSON.stringify(verify(read('get-inference-profile', ['--inference-profile-identifier', model]), read('get-foundation-model-availability', ['--model-id', model.slice(3)]), process.env)));
}
module.exports = {verify};
