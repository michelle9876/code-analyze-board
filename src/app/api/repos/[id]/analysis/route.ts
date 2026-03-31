import { NextResponse } from "next/server";
import { artifactScopeQuerySchema } from "@/lib/contracts";
import { prisma } from "@/lib/db";
import { toArtifactScope } from "@/lib/jobs";
import { getLatestArtifact, getRepositoryById, serializeArtifact } from "@/lib/queries";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const repository = await getRepositoryById(id);

  if (!repository) {
    return NextResponse.json(
      { error: "Repository를 찾을 수 없습니다." },
      { status: 404 }
    );
  }

  const url = new URL(request.url);
  const parsedScope = artifactScopeQuerySchema.safeParse(
    url.searchParams.get("scope") ?? "repo"
  );

  if (!parsedScope.success) {
    return NextResponse.json(
      { error: "지원하지 않는 analysis scope입니다." },
      { status: 400 }
    );
  }

  const scope = parsedScope.data;
  const path = url.searchParams.get("path") ?? "";

  if ((scope === "folder" || scope === "file") && !path) {
    return NextResponse.json(
      { error: "folder/file 분석 조회에는 path가 필요합니다." },
      { status: 400 }
    );
  }

  const artifactScope = toArtifactScope(scope);
  const artifactPath = scope === "folder" || scope === "file" ? path : "";

  const pendingWhere =
    artifactPath === ""
      ? {
          OR: [
            { path: "" },
            { path: null }
          ]
        }
      : {
          path: artifactPath
        };

  const [artifact, pendingJob] = await Promise.all([
    getLatestArtifact(repository.id, artifactScope, artifactPath, repository.headCommitSha),
    prisma.analysisJob.findFirst({
      where: {
        repositoryId: repository.id,
        scope: artifactScope,
        status: {
          in: ["PENDING", "RUNNING"]
        },
        ...pendingWhere
      },
      orderBy: {
        createdAt: "desc"
      }
    })
  ]);

  return NextResponse.json({
    artifact: artifact ? serializeArtifact(artifact) : null,
    pending: Boolean(pendingJob)
  });
}
