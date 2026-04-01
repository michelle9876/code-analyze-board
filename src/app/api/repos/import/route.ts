import { NextResponse } from "next/server";
import { importRepoRequestSchema } from "@/lib/contracts";
import { prisma } from "@/lib/db";
import { getRepositoryClonePath } from "@/lib/git";
import { enqueueJob } from "@/lib/jobs";
import { ensureDefaultCategories, serializeRepository } from "@/lib/queries";
import { normalizeGitHubUrl, parseGitHubUrl, resolveGitHubCloneUrl } from "@/lib/url";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const json = await request.json();
    const parsedBody = importRepoRequestSchema.safeParse(json);

    if (!parsedBody.success) {
      return NextResponse.json(
        { error: "유효한 GitHub URL을 입력해주세요." },
        { status: 400 }
      );
    }

    let canonicalUrl: string;
    let parsedUrl: { canonicalUrl: string; owner: string; name: string };
    let cloneUrl: string;

    try {
      canonicalUrl = normalizeGitHubUrl(parsedBody.data.url);
      parsedUrl = parseGitHubUrl(parsedBody.data.url);
      cloneUrl = resolveGitHubCloneUrl(parsedBody.data.url);
    } catch {
      return NextResponse.json(
        { error: "public GitHub repository URL 형식이 올바르지 않습니다." },
        { status: 400 }
      );
    }

    await ensureDefaultCategories();

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

    const existingRepository = await prisma.repository.findUnique({
      where: { canonicalUrl },
      include: { category: true }
    });

    if (existingRepository) {
      return NextResponse.json(
        {
          error: "이미 board에 등록된 repository입니다.",
          repository: serializeRepository(existingRepository)
        },
        { status: 409 }
      );
    }

    const repository = await prisma.repository.create({
      data: {
        name: parsedUrl.name,
        owner: parsedUrl.owner,
        url: cloneUrl,
        canonicalUrl,
        clonePath: getRepositoryClonePath(canonicalUrl),
        status: "IMPORTING",
        importProgress: 1,
        categoryId: parsedBody.data.categoryId ?? null
      },
      include: { category: true }
    });

    await enqueueJob(repository.id, {
      type: "IMPORT_REPOSITORY",
      priority: 0,
      force: true
    });

    return NextResponse.json(
      { repository: serializeRepository(repository) },
      { status: 201 }
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Repository import를 시작하지 못했습니다."
      },
      { status: 500 }
    );
  }
}
