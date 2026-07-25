# Deploying agent2web on Kubernetes (k3s)

The manifests in `k8s/` are plain YAML with a kustomization, sized for a
single-node k3s cluster (the target here is k3s on Hetzner). One replica, one
ReadWriteOnce volume, Traefik + cert-manager for TLS.

## 1. Generate secrets

On any machine with the repo checked out:

```bash
npm install
npm run gen-secrets
```

Copy `secret.example.yaml` to `secret.yaml`, paste the values in, and uncomment
`- secret.yaml` in `kustomization.yaml`. Keep `secret.yaml` out of git — or drop
it and use sealed-secrets / external-secrets instead.

## 2. Set your hostname

Edit both:

- `configmap.yaml` → `A2W_PUBLIC_URL` (e.g. `https://a2w.example.com`)
- `ingress.yaml` → the `host` and `tls.hosts` entries

`A2W_PUBLIC_URL` must be exactly the origin clients dial. It is the OAuth issuer
and the audience of the tokens this server issues, so a mismatch breaks the
Claude connector rather than merely looking untidy.

## 3. Apply

```bash
kubectl apply -k deploy/k8s
kubectl -n agent2web rollout status deploy/agent2web
curl -fsS https://a2w.example.com/healthz
```

Then open `https://a2w.example.com/admin` and sign in with the admin password.

## Storage

`pvc.yaml` requests 5Gi from the default StorageClass. On k3s that is
`local-path` (a directory on the node — fine, but tied to that node). With the
Hetzner CSI driver installed, uncomment `storageClassName: hcloud-volumes` for a
network volume that survives node replacement.

Everything lives under `/data`: `agent2web.db` plus `sites/<site-id>/<version-id>/`.
Backing up means copying that directory. For a consistent copy of the database
while the app is running:

```bash
kubectl -n agent2web exec deploy/agent2web -- \
  node -e "const D=require('better-sqlite3');new D('/data/agent2web.db').backup('/tmp/backup.db').then(()=>process.exit(0))"
kubectl -n agent2web cp agent2web-<pod>:/tmp/backup.db ./agent2web.db
```

## Wildcard subdomain hosting

Path URLs (`https://a2w.example.com/s/<slug>/`) always work with the single
certificate above. Subdomain URLs (`https://<slug>.sites.example.com/`) are
nicer — root-relative asset paths resolve, and each site gets its own origin —
but need two extra things:

1. **Wildcard DNS**: `*.sites.example.com` → the ingress IP.
2. **Wildcard certificate**: Let's Encrypt only issues these over DNS-01, so the
   ClusterIssuer needs a DNS solver for your provider. For Hetzner DNS use the
   [hetzner webhook](https://github.com/vadimkim/cert-manager-webhook-hetzner);
   Cloudflare is supported by cert-manager natively:

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: you@example.com
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
      - http01:
          ingress:
            ingressClassName: traefik
      - dns01:
          cloudflare:
            apiTokenSecretRef:
              name: cloudflare-api-token
              key: api-token
        selector:
          dnsNames:
            - '*.sites.example.com'
```

Then set `A2W_SITES_BASE_DOMAIN` in the ConfigMap and uncomment the wildcard host
in `ingress.yaml`.

Use a **different** domain for sites than for the app. Pages published here are
arbitrary HTML; giving them their own origin keeps them away from the admin
session. When they are served from the app origin under `/s/…`, agent2web
sandboxes them with a CSP instead (see `A2W_SITE_SANDBOX`).

## Custom domain for one site

```
site_set_domain(slug: "quarterly", domain: "reports.customer.example")
```

The app answers for that Host immediately; the rest is DNS and TLS, which it
deliberately does not touch:

1. Point `reports.customer.example` at the ingress (CNAME to your app host, or an
   A record to the ingress IP).
2. Add the host to `ingress.yaml` under both `tls.hosts` and `rules` (templates
   are commented in the file), then re-apply. cert-manager issues the
   certificate over HTTP-01 — no wildcard needed.

## Upgrades

```bash
kubectl -n agent2web set image deploy/agent2web agent2web=ghcr.io/raveli/agent2web:<tag>
```

The database migrates itself on boot. `strategy: Recreate` means the old pod is
stopped before the new one starts, so there is a few seconds of downtime — which
is what you want when a single SQLite file is involved.
