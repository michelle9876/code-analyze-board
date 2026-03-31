import { NextResponse } from "next/server";
import { getBoardRepositories, getCategories } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  const [repositories, categories] = await Promise.all([
    getBoardRepositories(),
    getCategories()
  ]);

  return NextResponse.json({
    repositories,
    categories
  });
}
