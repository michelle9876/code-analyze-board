import { NextResponse } from "next/server";
import { reanalyzeRequestSchema } from "@/lib/contracts";
import { enqueueAnalysisScope, enqueueRepositoryRefresh } from "@/lib/jobs";
import { getRepositoryById } from "@/lib/queries";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const repository = await getRepositoryById(id);

  if (!repository) {
    return NextResponse.json(
      { error: "Repository를 찾을 수 없습니다." },
      { status: 404 }
    );
  }

  const json = await request.json();
  const parsedBody = reanalyzeRequestSchema.safeParse(json);

  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "reanalyze payload가 올바르지 않습니다." },
      { status: 400 }
    );
  }

  const scope = parsedBody.data.scope ?? "repo";
  const path = parsedBody.data.path;

  if ((scope === "folder" || scope === "file") && !path) {
    return NextResponse.json(
      { error: "folder/file 재분석에는 path가 필요합니다." },
      { status: 400 }
    );
  }

  if (scope === "repo") {
    await enqueueRepositoryRefresh(repository.id, true);

    return NextResponse.json({
      ok: true
    });
  }

  await enqueueAnalysisScope(
    repository.id,
    scope,
    path,
    true,
    scope === "folder" || scope === "file" ? { coverageMode: "on-demand" } : undefined
  );

  return NextResponse.json({
    ok: true
  });
}
