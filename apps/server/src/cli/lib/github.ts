import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const REGISTRY_OWNER = process.env.OG_REGISTRY_OWNER || "ymh357";
const REGISTRY_REPO = process.env.OG_REGISTRY_REPO || "workflow-control-registry";

function gh(args: string[]): string {
  return execFileSync("gh", args, {
    encoding: "utf-8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function getRepoRef(): string {
  return `${REGISTRY_OWNER}/${REGISTRY_REPO}`;
}

function getDefaultBranch(): string {
  try {
    const result = gh([
      "api", `repos/${getRepoRef()}`,
      "--jq", ".default_branch",
    ]);
    return result || "main";
  } catch {
    return "main";
  }
}

async function getFileSha(filePath: string): Promise<string | null> {
  try {
    const result = gh([
      "api", `repos/${getRepoRef()}/contents/${filePath}`,
      "--jq", ".sha",
    ]);
    return result || null;
  } catch {
    return null;
  }
}

async function uploadFile(
  repoPath: string,
  content: string,
  message: string,
): Promise<void> {
  const sha = await getFileSha(repoPath);
  const b64 = Buffer.from(content, "utf-8").toString("base64");
  const body: Record<string, unknown> = { message, content: b64 };
  if (sha) body.sha = sha;

  try {
    gh([
      "api", `repos/${getRepoRef()}/contents/${repoPath}`,
      "--method", "PUT",
      "--input", "-",
    ].concat([]));
  } catch {
    // gh api --input doesn't work well, use --field approach instead
  }

  // Use gh api with raw-field for reliable JSON body
  const args = [
    "api", `repos/${getRepoRef()}/contents/${repoPath}`,
    "--method", "PUT",
    "-f", `message=${message}`,
    "-f", `content=${b64}`,
  ];
  if (sha) args.push("-f", `sha=${sha}`);

  execFileSync("gh", args, {
    encoding: "utf-8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export interface PublishOptions {
  packageDir: string;
  packageName: string;
  files: string[];
}

export async function publishToGitHub(opts: PublishOptions): Promise<void> {
  // Verify gh CLI is authenticated
  try {
    gh(["auth", "status"]);
  } catch (err) {
    throw new Error(
      "GitHub CLI (gh) is not authenticated. Run `gh auth login` first.",
    );
  }

  const { packageDir, packageName, files } = opts;

  // Upload manifest.yaml
  const manifestPath = path.join(packageDir, "manifest.yaml");
  const manifestContent = fs.readFileSync(manifestPath, "utf-8");
  const repoBase = `packages/${packageName}`;

  console.log(`  Uploading ${repoBase}/manifest.yaml`);
  await uploadFile(
    `${repoBase}/manifest.yaml`,
    manifestContent,
    `publish: ${packageName} manifest`,
  );

  // Upload all package files
  for (const file of files) {
    const filePath = path.join(packageDir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    console.log(`  Uploading ${repoBase}/${file}`);
    await uploadFile(
      `${repoBase}/${file}`,
      content,
      `publish: ${packageName}/${file}`,
    );
  }
}
