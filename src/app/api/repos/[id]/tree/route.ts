import { NextResponse } from "next/server";
import { getReadyAndPendingPaths, getRepositoryById } from "@/lib/queries";
import { buildRepositorySnapshot, createTreePayload } from "@/lib/repository";

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

  try {
    const [snapshot, { ready, pending }] = await Promise.all([
      buildRepositorySnapshot(repository.clonePath),
      getReadyAndPendingPaths(repository.id, repository.headCommitSha)
    ]);

    return NextResponse.json({
      tree: createTreePayload(snapshot.tree, ready, pending)
    });
  } catch {
    return NextResponse.json({
      tree: []
    });
  }
}
