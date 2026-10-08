{{/*
Expand the name of the chart.
*/}}
{{- define "infrashelf.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified base name.
*/}}
{{- define "infrashelf.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Fully qualified name for the frontend component.
*/}}
{{- define "infrashelf.frontend.fullname" -}}
{{- printf "%s-frontend" (include "infrashelf.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified name for the backend component.
*/}}
{{- define "infrashelf.backend.fullname" -}}
{{- printf "%s-backend" (include "infrashelf.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create chart label value.
*/}}
{{- define "infrashelf.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "infrashelf.labels" -}}
helm.sh/chart: {{ include "infrashelf.chart" . }}
{{ include "infrashelf.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels (base — without component).
*/}}
{{- define "infrashelf.selectorLabels" -}}
app.kubernetes.io/name: {{ include "infrashelf.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Frontend selector labels.
*/}}
{{- define "infrashelf.frontend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "infrashelf.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: frontend
{{- end }}

{{/*
Backend selector labels.
*/}}
{{- define "infrashelf.backend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "infrashelf.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: backend
{{- end }}

{{/*
Name of the Secret holding the backend's environment (DATABASE_URL, JWT_SECRET,
the sweep/drift/metrics secrets). When `backend.existingSecret` is set the chart
does not create a Secret of its own and every reference points at that one —
which is how one release per environment (dev, staging, prod) is bound to that
environment's own database credential without the URL ever entering a values
file. Empty means the chart creates and owns the Secret, as before.
*/}}
{{- define "infrashelf.backend.secretName" -}}
{{- if .Values.backend.existingSecret -}}
{{- .Values.backend.existingSecret | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "infrashelf.backend.fullname" . -}}
{{- end -}}
{{- end }}

{{/*
Same, for the frontend's Secret (NEXTAUTH_SECRET).
*/}}
{{- define "infrashelf.frontend.secretName" -}}
{{- if .Values.frontend.existingSecret -}}
{{- .Values.frontend.existingSecret | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "infrashelf.frontend.fullname" . -}}
{{- end -}}
{{- end }}

{{/*
Frontend image reference.
*/}}
{{- define "infrashelf.frontend.image" -}}
{{- $tag := .Values.frontend.image.tag | default .Chart.AppVersion }}
{{- printf "%s:%s" .Values.frontend.image.repository $tag }}
{{- end }}

{{/*
Backend image reference.
*/}}
{{- define "infrashelf.backend.image" -}}
{{- $tag := .Values.backend.image.tag | default .Chart.AppVersion }}
{{- printf "%s:%s" .Values.backend.image.repository $tag }}
{{- end }}
