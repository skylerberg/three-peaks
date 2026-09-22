terraform {
  required_version = ">= 1.5"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.41"
    }
  }

  backend "gcs" {
    bucket = "cow-terraform-state"
    prefix = "three-peaks"
  }
}

provider "google" {
  project = local.project
  region  = local.region
}
