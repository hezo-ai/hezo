# Packer template for the Hezo DigitalOcean Marketplace 1-Click image.
#
# It bakes Hezo into an Ubuntu snapshot by running the SAME installer the
# cloud-init path uses (deploy/provision.sh) in image-build mode, then runs
# DigitalOcean's canonical Marketplace cleanup + validation scripts.
#
# In image-build mode provision.sh installs and enables everything but does NOT
# start the services or derive the public URL — that happens on the END USER's
# first boot (hezo-firstboot derives <ip>.sslip.io, then Caddy + Hezo start).
#
# Build (external — needs a DigitalOcean account + API token):
#   export DIGITALOCEAN_TOKEN=dop_v1_...
#   packer init hezo.pkr.hcl
#   packer build hezo.pkr.hcl
#
# See README.md for the full build + Vendor Portal submission runbook.

packer {
  required_plugins {
    digitalocean = {
      version = ">= 1.4.0"
      source  = "github.com/digitalocean/digitalocean"
    }
  }
}

variable "do_token" {
  type      = string
  sensitive = true
  default   = env("DIGITALOCEAN_TOKEN")
}

variable "region" {
  type    = string
  default = "nyc3"
}

variable "base_image" {
  type    = string
  default = "ubuntu-24-04-x64"
}

variable "size" {
  type        = string
  description = "Build droplet size. A 2 GB box comfortably runs the install; the image works on any size the end user picks."
  default     = "s-2vcpu-2gb"
}

variable "hezo_release_tag" {
  type        = string
  description = "Hezo release to bake in (default: latest). Auto-update upgrades it after boot."
  default     = "latest"
}

variable "do_marketplace_ref" {
  type        = string
  description = "digitalocean/marketplace-partners git ref for the cleanup + img-check validators. Pin to a commit SHA for reproducible builds."
  default     = "master"
}

locals {
  timestamp = formatdate("YYYYMMDDhhmmss", timestamp())
}

source "digitalocean" "hezo" {
  api_token     = var.do_token
  image         = var.base_image
  region        = var.region
  size          = var.size
  ssh_username  = "root"
  snapshot_name = "hezo-${local.timestamp}"
  tags          = ["hezo", "marketplace"]
}

build {
  sources = ["source.digitalocean.hezo"]

  # Let the base image's own cloud-init finish before we touch it.
  provisioner "shell" {
    inline = ["cloud-init status --wait"]
  }

  # Upload the single-source installer shared with the cloud-init path.
  provisioner "file" {
    source      = "${path.root}/../../provision.sh"
    destination = "/opt/hezo-provision.sh"
  }

  # Bake Hezo in: install + enable, but don't start or derive the URL.
  provisioner "shell" {
    environment_vars = [
      "HEZO_IMAGE_BUILD=1",
      "HEZO_RELEASE_TAG=${var.hezo_release_tag}",
      "DEBIAN_FRONTEND=noninteractive",
    ]
    inline = [
      "chmod +x /opt/hezo-provision.sh",
      "bash /opt/hezo-provision.sh",
    ]
  }

  # DigitalOcean's canonical Marketplace cleanup + validation, fetched at build
  # time so we always run their current, unmodified checks. Pin do_marketplace_ref
  # to a commit SHA for a reproducible build. img-check exits non-zero on any
  # failed requirement, which correctly fails the build before submission.
  provisioner "shell" {
    environment_vars = ["DEBIAN_FRONTEND=noninteractive"]
    inline = [
      "set -e",
      "BASE=https://raw.githubusercontent.com/digitalocean/marketplace-partners/${var.do_marketplace_ref}/scripts",
      "curl -fsSL \"$BASE/90-cleanup.sh\" -o /tmp/90-cleanup.sh",
      "curl -fsSL \"$BASE/99-img-check.sh\" -o /tmp/99-img-check.sh",
      "bash /tmp/90-cleanup.sh",
      "bash /tmp/99-img-check.sh",
    ]
  }
}
