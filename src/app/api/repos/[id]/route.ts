import path from "node:path";
import { rm } from "node:fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getRepositoryById, serializeRepository } from "@/lib/queries";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function GET(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  const repository = await getRepositoryById(id);

  if (!repository) {
    return NextResponse.json(
      { error: "Repository를 찾을 수 없습니다." },
      { status: 404 }
    );
  }

  return NextResponse.json({
    repository: serializeRepository(repository)
  });
}

export async function DELETE(_request: Request, { params }: RouteContext) {
export async function DELETE(request: Request, { params }: RouteContext) {
  const { id } = await params;
  let deleteLocalClone = true;

  try {
    const body = await request.json();
    if (typeof body?.deleteLocalClone === "boolean") {
      deleteLocalClone = body.deleteLocalClone;
    }
  } catch {
    deleteLocalClone = true;
  }

  const repository = await prisma.repository.findUnique({
    where: { id },
    select: {
      id: true,
      clonePath: true,
      name: true
    }
  });

  if (!repository) {
    return NextResponse.json(
      { error: "Repository를 찾을 수 없습니다." },
      { status: 404 }
    );
  }

  try {
    if (deleteLocalClone) {
      const cloneRoot = path.resolve(process.env.REPO_STORAGE_ROOT || path.join(process.cwd(), "data", "repos"));
      const resolvedClonePath = path.resolve(repository.clonePath);

      if (!resolvedClonePath.startsWith(`${cloneRoot}${path.sep}`)) {
        return NextResponse.json(
          { error: "삭제 가능한 clone 경로가 아닙니다." },
          { status: 400 }
        );
      }

      await rm(resolvedClonePath, { recursive: true, force: true });
    }

    await prisma.$transaction([
      prisma.analysisArtifact.deleteMany({
        where: { repositoryId: repository.id }
      }),
      prisma.analysisJob.deleteMany({
        where: { repositoryId: repository.id }
      }),
      prisma.repository.delete({
        where: { id: repository.id }
      })
    ]);

    return NextResponse.json({
      deleted: true,
      id: repository.id,
      name: repository.name,
      deleteLocalClone
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Repository를 삭제하지 못했습니다."
      },
      { status: 500 }
    );
  }
}
