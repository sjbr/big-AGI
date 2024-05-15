provider "google" {
  project = "euphoric-world-383314"
  region  = "us-east5"
}

resource "google_cloud_run_service" "openai_api_service" {
  name     = "big-agi"
  location = "us-east5"

  template {
    spec {
      containers {
        image = "us-east5-docker.pkg.dev/euphoric-world-383314/big-agi/big-agi:1.16.1"
        env {
          name = "DEBUG"
          value = "1"
        }
        ports {
          container_port = 3000
        }

        resources {
          limits = {
            cpu    = "1000m"
            memory = "512Mi"
          }
        }
      }
    }

    metadata {
      annotations = {
        "autoscaling.knative.dev/maxScale"      = "1"
        "run.googleapis.com/startup-cpu-boost" = "true"
      }
     }
  }

  traffic {
    percent         = 100
    latest_revision = true
  }
}

resource "google_cloud_run_service_iam_member" "allUsers" {
  service  = google_cloud_run_service.openai_api_service.name
  location = google_cloud_run_service.openai_api_service.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "service_url" {
  value = google_cloud_run_service.openai_api_service.status[0].url
}
