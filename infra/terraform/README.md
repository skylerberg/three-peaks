# Infrastructure

Everything below lives in the existing `realm-construction` GCP project and the
existing `cow-cluster` GKE cluster. State is in `gs://cow-terraform-state` under
the `three-peaks` prefix.

## Current state (2026-08-21)

**Live at https://tools.threepeaksgames.com, and fully bootstrapped.** Terraform
is applied with `attach_wildcard_cert_map = true`, both certificates are ACTIVE,
both API replicas are HEALTHY in the load balancer's NEG, and uploads reach GCS
through Workload Identity with no key file anywhere.

Per-PR previews work end to end and the URLs in the PR comments are live:
opening a pull request publishes to `pr/<n>/` and comments the URL, and closing
it removes both.

DNS is complete — the apex `A`, the wildcard `A` for `pr-<n>`, and the DNS-01
`CNAME` the wildcard certificate renews against are all in Route 53. Nothing
here is waiting on anything.

Secrets are readable back out of the cluster if they are needed again:

```sh
kubectl -n three-peaks get secret three-peaks-secrets \
  -o jsonpath='{.data.DB_PASSWORD}' | base64 -d
```

## The ordering problem

`data "google_compute_network_endpoint_group" "api"` reads a NEG that **GKE
creates** from the `cloud.google.com/neg` annotation on the Service. On a fresh
environment that NEG does not exist until the first deploy has run, so a single
`terraform apply` from nothing cannot succeed. It is a two-pass bootstrap.

## First-time bootstrap

0. **Let this repository authenticate to GCP.** Workload Identity bindings are
   per-repository, so until this is added every deploy fails at the auth step
   with `iam.serviceAccounts.getAccessToken denied`. This is a privilege grant
   on a shared project — read it before running it.

   ```sh
   gcloud iam service-accounts add-iam-policy-binding \
     github-actions-service@realm-construction.iam.gserviceaccount.com \
     --project=realm-construction \
     --role=roles/iam.workloadIdentityUser \
     --member='principalSet://iam.googleapis.com/projects/1085332810847/locations/global/workloadIdentityPools/default-pool/attribute.repository/skylerberg/three-peaks'
   ```

   Confirm it landed beside the existing repositories:

   ```sh
   gcloud iam service-accounts get-iam-policy \
     github-actions-service@realm-construction.iam.gserviceaccount.com \
     --project=realm-construction
   ```

1. **Create everything the cluster does not depend on.**

   ```sh
   terraform init
   terraform apply \
     -target=google_service_account.api \
     -target=google_service_account_iam_member.api_workload_identity \
     -target=google_storage_bucket.uploads \
     -target=google_storage_bucket_iam_member.uploads_api \
     -target=google_storage_bucket.web \
     -target=google_artifact_registry_repository.main \
     -target=google_compute_global_address.main
   ```

2. **Point DNS at the load balancer.** `threepeaksgames.com` is on **Route 53**,
   not Cloud DNS, and there is no `aws` CLI here — this is a console step.

   ```sh
   terraform output lb_ip     # A record: tools.threepeaksgames.com
   ```

   The Google-managed certificate cannot validate until this resolves.

3. **Create the database and role** on the shared Cloud SQL instance
   `master-instance` (private IP `10.122.128.3`):

   ```sql
   create role three_peaks_hub with login password '<generated>';
   create database three_peaks_hub owner three_peaks_hub;
   ```

4. **Create the namespace and its secret.** By hand, once — there is no
   sealed-secrets or external-secrets in this setup, and GCS needs no key at all
   because the pod reaches it through Workload Identity.

   ```sh
   kubectl create namespace three-peaks
   kubectl -n three-peaks create secret generic three-peaks-secrets \
     --from-literal=DB_PASSWORD='<the password from step 3>' \
     --from-literal=PASSWORD_RESET_SECRET="$(openssl rand -base64 32)" \
     --from-literal=REDIS_PASSWORD="$(openssl rand -base64 24)" \
     --from-literal=REDIS_URL='redis://:<the redis password>@three-peaks-redis:6379'
   ```

5. **Push to `main`.** The deploy workflow builds the image, applies the base
   manifests, runs the migration Job and rolls out — and applying the Service is
   what makes GKE create `three-peaks-api-neg`.

6. **Apply the rest.** The NEG now resolves, so the backend service, URL map,
   proxies and forwarding rules can be created.

   ```sh
   terraform apply
   ```

7. **Wait for the certificate.** Up to ~20 minutes after DNS resolves.

   ```sh
   gcloud compute ssl-certificates describe three-peaks-hub-cert \
     --global --format='value(managed.status)'
   ```

## Enabling preview subdomains

Previews are served at `pr-<n>.tools.threepeaksgames.com`, which needs a
wildcard certificate. The classic Compute managed certificate cannot issue one —
its CA connects to a concrete hostname to prove control — so the wildcard comes
from Certificate Manager with a DNS-01 authorization, and attaching it is a
second apply.

1. Publish the CNAME in Route 53:

   ```sh
   terraform output wildcard_cert_dns_validation
   ```

2. Wait for `ACTIVE`. Attaching the map before this hands the HTTPS proxy a
   certificate it cannot serve:

   ```sh
   gcloud certificate-manager certificates describe three-peaks-hub-wildcard-cert \
     --location=global --format='value(managed.state)'
   ```

3. Attach it:

   ```sh
   terraform apply -var attach_wildcard_cert_map=true
   ```

4. Add a wildcard A record for `*.tools.threepeaksgames.com` pointing at the
   same `lb_ip`.

## Things that will bite

- **The node tag is hard-coded.** `local.gke_node_tag` must match the cluster's
  node pool, or health checks never reach the pods. Read it with:

  ```sh
  gcloud compute instances list --filter="name~gke-cow-cluster" \
    --format="value(tags.items)"
  ```

- **The firewall rule is deliberately separate** from critical-path's, even
  though the two overlap. GCP allows overlapping allow rules, and a
  `terraform destroy` of that stack must not silently break health checks here.

- **`terraform apply` is manual.** CI only runs `fmt -check` and `validate`; a
  plan on pull requests would need state read access and a privileged workflow.
