#!/usr/bin/env bash
# Run from the user's Mac: bash deploy/build-and-push.sh push
# This script uploads an image only; it never changes an ECS service or IAM policy.
set -euo pipefail

mode="${1:-build}"
case "$mode" in build|push) ;; *) echo 'Usage: bash deploy/build-and-push.sh [build|push]' >&2; exit 2 ;; esac
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_root"

for tool in node npm git docker; do
  command -v "$tool" >/dev/null || { echo "Missing command: $tool" >&2; exit 1; }
done
node -e 'if(Number(process.versions.node.split(".")[0])<22){console.error("Node.js 22 or later is required");process.exit(1)}'
if [ -n "$(git status --porcelain -- server client shared supabase package.json package-lock.json vite.config.js)" ]; then
  echo 'Application changes are not committed. Review and commit them first so the release has an identifiable source version.' >&2
  exit 1
fi
source_commit="$(git rev-parse HEAD)"
image_tag="${ABKP_IMAGE_TAG:-passkey-$(date -u +%Y%m%d%H%M%S)-${source_commit:0:7}}"
if ! [[ "$image_tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo 'Invalid ABKP_IMAGE_TAG.' >&2; exit 1
fi
profile_name="${ABKP_AWS_PROFILE:-abist-design-knowledge-demo}"
region_name='ap-northeast-1'
expected_account='399695959107'
repository_name='abist-design-knowledge-demo'
registry_uri="${expected_account}.dkr.ecr.${region_name}.amazonaws.com"
repository_uri="${registry_uri}/${repository_name}"
local_image="${repository_name}:${image_tag}"
remote_image="${repository_uri}:${image_tag}"

if [ "$mode" = push ]; then
  command -v aws >/dev/null || { echo 'AWS CLI is missing.' >&2; exit 1; }
  caller_account="$(aws sts get-caller-identity --profile "$profile_name" --region "$region_name" --query Account --output text --no-cli-pager)"
  [ "$caller_account" = "$expected_account" ] || { echo 'AWS account does not match the approved Demo account. Stopping.' >&2; exit 1; }
  actual_repository="$(aws ecr describe-repositories --repository-names "$repository_name" --region "$region_name" --profile "$profile_name" --query 'repositories[0].repositoryUri' --output text --no-cli-pager)"
  [ "$actual_repository" = "$repository_uri" ] || { echo 'ECR repository does not match. Stopping.' >&2; exit 1; }
fi

echo 'Checking Docker Engine and Buildx...'
docker version
docker buildx version
docker buildx inspect --bootstrap
echo 'Installing locked dependencies and running application tests...'
npm ci --include=dev --no-audit --no-fund
npm test
echo "Building ${local_image} for linux/amd64..."
docker buildx build --platform linux/amd64 --load --file deploy/Dockerfile.ecs --tag "$local_image" .
image_platform="$(docker image inspect "$local_image" --format '{{.Os}}/{{.Architecture}}')"
[ "$image_platform" = linux/amd64 ] || { echo "Unexpected image platform: $image_platform" >&2; exit 1; }

container_id=''
cleanup() {
  if [ -n "$container_id" ]; then docker stop -t 5 "$container_id" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Isolated, disposable smoke test only. The released image defaults to DEMO_MODE=false.
# No .env or real database credentials are mounted into this test container.
container_id="$(docker run --rm --detach --init --publish 127.0.0.1::3001 --env DEMO_MODE=true "$local_image")"
local_port="$(docker inspect "$container_id" --format '{{(index (index .NetworkSettings.Ports "3001/tcp") 0).HostPort}}')"
base_url="http://127.0.0.1:${local_port}"
ready=false
for attempt in {1..30}; do
  if node --input-type=module - "$base_url" <<'NODE' >/dev/null 2>&1
const response = await fetch(process.argv[2] + '/api/health', { signal: AbortSignal.timeout(1500) });
const body = await response.json();
if (!response.ok || body.ok !== true || body.mode !== 'demo') process.exit(1);
NODE
  then ready=true; break; fi
  sleep 1
done
if [ "$ready" != true ]; then
  docker logs "$container_id" >&2
  echo 'Container did not become healthy. Image was not pushed.' >&2
  exit 1
fi
node --input-type=module - "$base_url" <<'NODE'
const base = process.argv[2];
const options = { signal: AbortSignal.timeout(5000) };
const page = await fetch(base + '/', options);
if (!page.ok || !(await page.text()).includes('/assets/')) throw new Error('Built frontend was not served');
const denied = await fetch(base + '/api/state', { signal: AbortSignal.timeout(5000) });
if (denied.status !== 401) throw new Error('Unauthenticated access to state was not rejected');
console.log('Image smoke test passed: startup, frontend, and unauthenticated API rejection. Production Passkey/DB verification is still required.');
NODE
cleanup
container_id=''

if [ "$mode" = build ]; then
  echo "Built and smoke-tested: ${local_image}"
  echo 'Nothing was uploaded or deployed. Use the push argument to build, verify, and upload.'
  exit 0
fi

aws ecr get-login-password --region "$region_name" --profile "$profile_name" |
  docker login --username AWS --password-stdin "$registry_uri"
docker tag "$local_image" "$remote_image"
docker push "$remote_image"
image_digest="$(aws ecr describe-images --repository-name "$repository_name" --image-ids "imageTag=${image_tag}" --region "$region_name" --profile "$profile_name" --query 'imageDetails[0].imageDigest' --output text --no-cli-pager)"
[[ "$image_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'ECR image digest could not be verified.' >&2; exit 1; }
mkdir -p .data
node --input-type=module - "$remote_image" "$image_digest" "$source_commit" <<'NODE'
import { writeFileSync } from 'node:fs';
const receipt = { image: process.argv[2], digest: process.argv[3], sourceCommit: process.argv[4], verifiedAt: new Date().toISOString(), ecsDeployment: 'not-started' };
writeFileSync('.data/last-ecr-push.json', JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
NODE
echo 'ECR upload verified. Next: configure the Demo service, HTTPS origin, and runtime secrets; then validate Passkey login and data persistence.'
