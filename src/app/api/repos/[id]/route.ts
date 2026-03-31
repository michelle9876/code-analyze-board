import { NextResponse } from "next/server";
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
