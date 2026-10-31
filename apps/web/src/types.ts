/** Rows as the API returns them (snake_case from the database). */
import type { AnalysisReport, AppConfiguration } from '@git2app/shared';

export interface Installation {
  installation_id: number;
  account_name: string;
  account_type: 'User' | 'Organization';
}

export interface Repo {
  installationId: number;
  id: number;
  name: string;
  owner: string;
  fullName: string;
  description: string | null;
  defaultBranch: string;
  updatedAt: string;
  language: string | null;
  visibility: 'private' | 'public';
}

export interface Project {
  id: string;
  installation_id: number;
  repository_id: number;
  repository_name: string;
  repository_url: string;
  branch: string;
  project_root: string;
  output_dir: string | null;
  hosted_origin: string | null;
  auto_build: boolean;
  created_at: string;
}

export interface AnalysisRow {
  id: string;
  commit_sha: string;
  framework_detected: string | null;
  pwa_detected: boolean;
  compatibility_score: number | null;
  recommended_android_strategy: 'twa' | 'capacitor' | 'unsupported';
  recommended_ios_strategy: 'capacitor' | 'unsupported';
  analysis_report: AnalysisReport;
  created_at: string;
}

export interface AnalysisJob {
  id: string;
  status: string;
  commit_sha: string;
  error_message: string | null;
  created_at: string;
}

export type SavedConfig = AppConfiguration & { id: string };

export interface Build {
  id: string;
  project_id: string;
  platform: 'android' | 'ios';
  packaging_strategy: 'twa' | 'capacitor';
  variant: 'debug' | 'release';
  status: string;
  commit_sha: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
}

export interface Artifact {
  id: string;
  artifact_type: string;
  file_size: number;
  checksum: string;
  validated: boolean;
  expires_at: string;
  created_at: string;
}

export interface Credential {
  id: string;
  platform: 'android' | 'ios';
  credential_type: string;
  label: string;
  created_at: string;
}
