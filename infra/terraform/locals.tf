locals {
  project = "realm-construction"
  region  = "us-west1"
  zone    = "us-west1-a"

  name = "three-peaks"

  # The address and every certificate keep the old name, and deliberately.
  # A GCP resource name is immutable, so renaming one of these is a destroy
  # and a create: the address comes back as a different IP, and each
  # certificate re-validates from scratch behind a map the proxy is already
  # serving. Both cost a Route 53 edit this project cannot make from inside
  # GCP, and a window where tools.threepeaksgames.com resolves to nothing --
  # paid for names that no request, log line or dashboard ever reads.
  tls_name = "three-peaks-hub"
  domain   = "tools.threepeaksgames.com"

  # Previews are served at pr-<n>.tools.threepeaksgames.com, which is why the
  # wildcard certificate below exists.
  preview_host_suffix = ".tools.threepeaksgames.com"

  # The node pool's network tag, needed by the health-check firewall rule. If it
  # is wrong, health checks never reach the pods; README.md says how to read the
  # current one off a node.
  gke_node_tag = "gke-cow-cluster-c4b67ea8-node"

  # The pod's serving port. GCLB health checks reach standalone-NEG endpoints
  # here rather than on the Service's port.
  api_port = 3001
}

variable "attach_wildcard_cert_map" {
  type    = bool
  default = false

  description = <<-EOT
    Attach the wildcard certificate map to the HTTPS proxy. Leave false until
    `gcloud certificate-manager certificates describe three-peaks-hub-wildcard-cert
    --location=global` reports ACTIVE, which needs the DNS-01 CNAME from
    `terraform output wildcard_cert_dns_validation` published in Route 53 first.
    Attaching it earlier hands the proxy a certificate it cannot serve.
  EOT
}
