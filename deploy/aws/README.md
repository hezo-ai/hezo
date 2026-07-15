# Hezo — AWS one-click deploy (CloudFormation)

This builds the **"Launch Stack"** button for AWS. It stands up a single Ubuntu
EC2 instance and runs the same [`deploy/provision.sh`](../provision.sh) the
cloud-init path uses (Docker + the `hezo` binary + Caddy automatic HTTPS via
`<ip>.sslip.io` + systemd + firewall), so there is one source of truth for how a
host is set up.

Hezo runs each project's agents in a container on the **host Docker socket**, so
it needs a real VM — not a managed-container service. EC2 is exactly that;
`hezo.cfn.yaml` provisions it.

The end-user experience: click **Launch Stack** → pick an instance size (and
optionally an SSH key pair / custom domain) → **Create stack** → wait ~2 min for
first boot → open the `URL` in the stack **Outputs** → finish the short setup
(master key, admin password, model).

## What's code (here) vs. external ops

| Step | Where |
|---|---|
| CloudFormation template (`hezo.cfn.yaml`, reusing `provision.sh`) | **This repo** |
| Hosting the template at a public URL CloudFormation accepts (see below) | **Done** — hosted at `hezo-deploy.s3.us-east-1.amazonaws.com/hezo.cfn.yaml`; re-upload on each release |
| The end user running the stack (their AWS account, their bill) | **External** — they click the button |

CloudFormation's quick-create ("Launch Stack") link requires `templateURL` to
point at a template stored in **Amazon S3** — a `raw.githubusercontent.com` URL
is rejected. The template is hosted for this at
`https://hezo-deploy.s3.us-east-1.amazonaws.com/hezo.cfn.yaml` (a public,
org-owned bucket); keep that object in sync with this file on each release (see
[Publishing](#publishing-the-button)). The manual paths below also work with the
in-repo file directly.

## The Launch Stack button

The README's **Deploy on AWS** badge points at the hosted template. The button URL:

```
https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?templateURL=https://hezo-deploy.s3.us-east-1.amazonaws.com/hezo.cfn.yaml&stackName=hezo
```

Markdown for the button:

```md
[![Launch Stack](https://s3.amazonaws.com/cloudformation-examples/cloudformation-launch-stack.png)](https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?templateURL=https://hezo-deploy.s3.us-east-1.amazonaws.com/hezo.cfn.yaml&stackName=hezo)
```

The user can switch region in the console before creating; the AMI resolves per
region automatically from Canonical's public SSM parameter, so the template is
region-agnostic.

## Deploy it now (no hosted button needed)

The template works today from the local file. Either path creates the same stack.

**AWS CLI:**

```sh
cd deploy/aws
aws cloudformation deploy \
  --template-file hezo.cfn.yaml \
  --stack-name hezo \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides InstanceType=t3.medium
# then read the URL:
aws cloudformation describe-stacks --stack-name hezo \
  --query "Stacks[0].Outputs[?OutputKey=='URL'].OutputValue" --output text
```

`CAPABILITY_IAM` is required because the template attaches a small IAM role so you
can open a shell via **Systems Manager Session Manager** even without an SSH key
pair. The console's quick-create page shows this as a checkbox to acknowledge.

**Console (upload):** CloudFormation → Create stack → *With new resources* →
*Upload a template file* → choose `hezo.cfn.yaml` → fill parameters → acknowledge
the IAM capability → Create.

## Parameters

| Parameter | Default | Notes |
|---|---|---|
| `InstanceType` | `t3.small` | 2 GB runs the install; **t3.medium+ recommended** for real agent work. |
| `VolumeSize` | `30` | Root EBS (GiB) — holds Hezo's data directory. |
| `KeyName` | *(empty)* | Optional SSH key pair. Blank = launch without one (use Session Manager). |
| `AllowedSshCidr` | `0.0.0.0/0` | Source CIDR for SSH; narrow to your IP. Only used if a key pair is set. |
| `DomainOverride` | *(empty)* | Use your own domain instead of `<ip>.sslip.io` (point an A record first). |
| `HezoReleaseTag` | `latest` | Pin a release; in-app update upgrades it later. |
| `LatestUbuntuAmi` | *(SSM)* | Resolves to the latest Ubuntu 24.04 AMI in-region. Leave as-is. |

## Test the stack before publishing

1. `aws cloudformation deploy ...` as above (a throwaway account/region is fine).
2. From your laptop, hit `https://<URL>/health` — a valid (non-self-signed)
   certificate proves the Let's Encrypt path provisioned against sslip.io on first
   boot. (Give it ~2 min after `CREATE_COMPLETE`; the cert is obtained on first boot.)
3. Load the root `URL` and confirm you reach the master-key gate; complete the
   three setup steps. The CEO chat's live log stream proves WebSocket passthrough.
4. Confirm the container→host path (agents' tools) is open by SSHing / Session
   Manager in and running:
   ```sh
   docker run --rm --add-host=host.docker.internal:host-gateway curlimages/curl \
     curl -sv --max-time 5 http://host.docker.internal:3100/mcp
   ```
   Any HTTP status (even 401/404) is success; a timeout means the `docker0`
   firewall rule is wrong. See
   [`docs/deployment/self-hosting.md`](../../docs/deployment/self-hosting.md)
   § Networking & firewall.
5. `aws cloudformation delete-stack --stack-name hezo` to tear it down.

## Publishing the button

The template is hosted in the org-owned `hezo-deploy` bucket (us-east-1). New
buckets block public ACLs by default, so the object is made public with a
**bucket policy** (not `--acl public-read`), then updated on each release:

```sh
# Re-upload after any change to hezo.cfn.yaml:
aws s3 cp deploy/aws/hezo.cfn.yaml s3://hezo-deploy/hezo.cfn.yaml \
  --content-type text/yaml
# Public URL wired into the Launch Stack button:
#   https://hezo-deploy.s3.us-east-1.amazonaws.com/hezo.cfn.yaml
```

**Keep the hosted object in sync with this file** — the button always serves
whatever is in S3, so a stale copy ships a stale template. A `release-publish`
workflow step can `aws s3 cp` it automatically (needs an AWS key scoped to
`s3:PutObject` on that bucket, stored as a GitHub Actions secret).
