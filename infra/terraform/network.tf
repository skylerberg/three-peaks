resource "google_compute_global_address" "main" {
  name = "${local.tls_name}-ip"
}

resource "google_compute_managed_ssl_certificate" "main" {
  name = "${local.tls_name}-cert"

  managed {
    domains = [local.domain]
  }
}

# --- Wildcard certificate for pr-<n> previews -------------------------------
# The classic Compute managed certificate cannot validate a wildcard: its CA
# connects to a concrete hostname to prove control. Certificate Manager can,
# using a DNS-01 authorization -- one authorization for the parent domain covers
# both it and its wildcard.

resource "google_certificate_manager_dns_authorization" "preview" {
  name     = "${local.tls_name}-preview-dns-auth"
  location = "global"
  domain   = local.domain
}

resource "google_certificate_manager_certificate" "wildcard" {
  name     = "${local.tls_name}-wildcard-cert"
  location = "global"
  scope    = "DEFAULT"

  managed {
    # The apex is listed here as well as the wildcard, which does not cover it.
    # Whether an attached map supersedes `ssl_certificates` or merely
    # supplements it is not something the documentation settles, so covering the
    # apex in both places keeps it serving either way.
    domains            = [local.domain, "*.${local.domain}"]
    dns_authorizations = [google_certificate_manager_dns_authorization.preview.id]
  }
}

resource "google_certificate_manager_certificate_map" "wildcard" {
  # Certificate maps are always global; the API pins the location, so there is
  # no argument for it here.
  name = "${local.tls_name}-wildcard-map"
}

resource "google_certificate_manager_certificate_map_entry" "wildcard" {
  name         = "${local.tls_name}-wildcard-entry"
  map          = google_certificate_manager_certificate_map.wildcard.name
  hostname     = "*.${local.domain}"
  certificates = [google_certificate_manager_certificate.wildcard.id]
}

# SNI matching no hostname entry lands here, so the apex still has something to
# serve if the map does supersede ssl_certificates.
resource "google_certificate_manager_certificate_map_entry" "primary" {
  name         = "${local.tls_name}-primary-entry"
  map          = google_certificate_manager_certificate_map.wildcard.name
  matcher      = "PRIMARY"
  certificates = [google_certificate_manager_certificate.wildcard.id]
}

# --- Load balancer ----------------------------------------------------------

resource "google_compute_url_map" "main" {
  name            = "${local.name}-url-map"
  default_service = google_compute_backend_bucket.web.self_link

  host_rule {
    hosts        = [local.domain]
    path_matcher = "main"
  }

  host_rule {
    hosts        = ["*.${local.domain}"]
    path_matcher = "previews"
  }

  path_matcher {
    name            = "main"
    default_service = google_compute_backend_bucket.web.self_link

    # The bucket cannot set security headers itself. replace = true keeps this
    # from stacking on the API's own HSTS header on the routes below.
    header_action {
      response_headers_to_add {
        header_name  = "Strict-Transport-Security"
        header_value = "max-age=31536000; includeSubDomains"
        replace      = true
      }
    }

    # route_rules rather than path_rule: a matcher may use one or the other, not
    # both, and the SPA fallback below needs a per-rule error policy.
    route_rules {
      priority = 1
      service  = google_compute_backend_service.api.self_link
      match_rules {
        prefix_match = "/api/"
      }
    }

    route_rules {
      priority = 2
      service  = google_compute_backend_service.api.self_link
      match_rules {
        full_path_match = "/ws"
      }
    }

    route_rules {
      priority = 3
      service  = google_compute_backend_service.api.self_link
      match_rules {
        full_path_match = "/health"
      }
    }

    # Above the SPA fallback deliberately. Asset filenames are content-hashed,
    # so a miss is a genuine miss and must stay a 404 rather than becoming an
    # HTML body that a <script> tag fails to parse.
    route_rules {
      priority = 4
      service  = google_compute_backend_bucket.web.self_link
      match_rules {
        prefix_match = "/assets/"
      }
    }

    # The catch-all, and the only rule that rewrites a 404. It sits on a rule
    # rather than on the matcher default because a matcher-level policy also
    # governs every route rule that defines none of its own -- which would turn
    # a genuine API 404 into the app shell with a 200.
    route_rules {
      priority = 5
      service  = google_compute_backend_bucket.web.self_link
      match_rules {
        prefix_match = "/"
      }

      custom_error_response_policy {
        error_service = google_compute_backend_bucket.web.self_link
        error_response_rule {
          match_response_codes   = ["404"]
          path                   = "/index.html"
          override_response_code = 200
        }
      }
    }
  }

  # pr-<n>.tools.threepeaksgames.com gets the same API routing as production, so
  # a preview is a full same-origin virtual host and needs no CORS.
  path_matcher {
    name            = "previews"
    default_service = google_compute_backend_service.preview_edge.self_link

    route_rules {
      priority = 1
      service  = google_compute_backend_service.api.self_link
      match_rules {
        prefix_match = "/api/"
      }
    }

    route_rules {
      priority = 2
      service  = google_compute_backend_service.api.self_link
      match_rules {
        full_path_match = "/ws"
      }
    }

    route_rules {
      priority = 3
      service  = google_compute_backend_service.api.self_link
      match_rules {
        full_path_match = "/health"
      }
    }
  }
}

resource "google_compute_url_map" "http_redirect" {
  name = "${local.name}-http-redirect-map"

  default_url_redirect {
    https_redirect = true
    strip_query    = false
  }
}

resource "google_compute_target_https_proxy" "main" {
  name             = "${local.name}-https-proxy"
  url_map          = google_compute_url_map.main.self_link
  ssl_certificates = [google_compute_managed_ssl_certificate.main.self_link]

  # Held off until the wildcard certificate reports ACTIVE. Its map entries
  # point at a certificate that stays PENDING until the DNS-01 CNAME resolves,
  # so attaching it early hands the proxy something it cannot serve.
  certificate_map = var.attach_wildcard_cert_map ? "//certificatemanager.googleapis.com/${google_certificate_manager_certificate_map.wildcard.id}" : null
}

resource "google_compute_target_http_proxy" "http_redirect" {
  name    = "${local.name}-http-redirect-proxy"
  url_map = google_compute_url_map.http_redirect.self_link
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "${local.name}-https-rule"
  ip_protocol           = "TCP"
  port_range            = "443"
  ip_address            = google_compute_global_address.main.address
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_https_proxy.main.self_link
}

resource "google_compute_global_forwarding_rule" "http_redirect" {
  name                  = "${local.name}-http-redirect-rule"
  ip_protocol           = "TCP"
  port_range            = "80"
  ip_address            = google_compute_global_address.main.address
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_http_proxy.http_redirect.self_link
}
