#!/usr/bin/env bash
set -euo pipefail
[[ ${GITHUB_ACTIONS:-} == true ]] || { echo 'Infrastructure is deployed only by GitHub Actions.' >&2; exit 1; }

# Never silently replace one identity system with another in an existing stack.
if aws cloudformation describe-stacks --stack-name "$AUTH_STACK_NAME" > "$RUNNER_TEMP/previous-auth-stack.json" 2> "$RUNNER_TEMP/describe-auth-error"; then
  existing=$(jq -r '.Stacks[0].Parameters[] | select(.ParameterKey == "AuthProvider") | .ParameterValue' "$RUNNER_TEMP/previous-auth-stack.json")
  [[ $existing == "$AUTH_PROVIDER" ]] || { echo 'Provider changes require a separate environment and explicit identity migration.' >&2; exit 1; }
elif ! grep -q 'does not exist' "$RUNNER_TEMP/describe-auth-error"; then
  cat "$RUNNER_TEMP/describe-auth-error" >&2
  exit 1
fi
aws cloudformation validate-template --template-body file://infra/auth-environment.yaml > /dev/null
aws cloudformation deploy --stack-name "$AUTH_STACK_NAME" --template-file infra/auth-environment.yaml \
  --parameter-overrides "AuthProvider=$AUTH_PROVIDER" "DomainPrefix=$COGNITO_DOMAIN_PREFIX" \
  --tags "Service=$SERVICE_NAME" --no-fail-on-empty-changeset
aws cloudformation describe-stacks --stack-name "$AUTH_STACK_NAME" > "$RUNNER_TEMP/auth-stack.json"
node scripts/ci/deployment-config.cjs auth "$RUNNER_TEMP/auth-stack.json"
