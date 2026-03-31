import { NextResponse } from "next/server";
import { updateCategoryRequestSchema } from "@/lib/contracts";
import { prisma } from "@/lib/db";
import { getRepositoryById, serializeRepository } from "@/lib/queries";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export async function PATCH(request: Request, { params }: RouteContext) {
  const { id } = await params;
  const repository = await getRepositoryById(id);

  if (!repository) {
    return NextResponse.json(
      { error: "Repository를 찾을 수 없습니다." },
      { status: 404 }
    );
  }

  const json = await request.json();
  const parsedBody = updateCategoryRequestSchema.safeParse(json);

  if (!parsedBody.success) {
    return NextResponse.json(
      { error: "categoryId payload가 올바르지 않습니다." },
      { status: 400 }
    );
  }

  if (parsedBody.data.categoryId) {
    const category = await prisma.category.findUnique({
      where: { id: parsedBody.data.categoryId }
    });

    if (!category) {
      return NextResponse.json(
        { error: "선택한 category를 찾을 수 없습니다." },
        { status: 400 }
      );
    }
  }

  const updatedRepository = await prisma.repository.update({
    where: { id: repository.id },
    data: {
      categoryId: parsedBody.data.categoryId
    },
    include: {
      category: true
    }
  });

  return NextResponse.json({
    repository: serializeRepository(updatedRepository)
  });
}
