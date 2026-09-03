---
paths:
  - "infra/k8s/**"
  - "infra/terraform/**"
---

# Kubernetes manifest rules (Phase 5+)

Workspace pods run hostile code. These are checklist items, not judgment calls — a manifest
missing one doesn't merge.

## Every workspace pod

`securityContext`:
- `runAsNonRoot: true`, `runAsUser` non-zero
- `allowPrivilegeEscalation: false`
- `capabilities: { drop: ["ALL"] }`
- `readOnlyRootFilesystem: true` (mount an `emptyDir` for the writable project path)
- `seccompProfile: { type: RuntimeDefault }`

Also required:
- **`automountServiceAccountToken: false`** — the default mounts a token that talks to the K8s
  API *from inside the sandbox*. Quietly the most dangerous default in the file.
- `resources.limits` for `cpu`, `memory`, **and `ephemeral-storage`** (a filled node disk takes
  down every pod on it, not just this one)
- Labels `owner`, `project`, `created-at` — the idle reaper finds pods by label; an unlabeled
  pod lives forever
- `runtimeClassName: gvisor` (Phase 9)

## Never, in a workspace pod

`privileged: true` · `hostNetwork` · `hostPID` · `hostIPC` · any `hostPath` mount · the Docker
socket · a real Secret. Each hands the node or the control plane to user code.

## Network

- **Default-deny egress** NetworkPolicy, allow-listed outward from nothing.
- **Explicitly block `169.254.169.254`.** The cloud metadata endpoint is how escaped code
  assumes the node's IAM role and reaches your whole account.
- Workspace pods cannot reach each other, the database, or Redis. Only the gateway reaches
  them, and only inbound.

## Namespaces and RBAC

- **Control plane and workspace pods live in separate namespaces.** ResourceQuota on the
  workspace namespace so one busy hour can't starve the control plane.
- The orchestrator's ServiceAccount is **namespace-scoped and least-privilege**: create, list,
  delete pods in the workspace namespace. Nothing cluster-wide, never `cluster-admin`. Nothing
  else in the system gets K8s API access at all.

## Practice

- Generated pods come from a **template committed here**, so security context is inherited by
  construction rather than remembered by whoever wrote the orchestrator.
- No image tag is `latest` — pin by digest.
- Terraform: state is remote and locked; no credentials in `.tf`; billing alerts exist before
  the first billable resource.
