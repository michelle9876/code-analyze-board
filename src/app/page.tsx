import { BoardShell } from "@/components/board-shell";
import { getBoardRepositories, getCategories } from "@/lib/queries";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [initialRepositories, categories] = await Promise.all([
    getBoardRepositories(),
    getCategories()
  ]);

  return (
    <BoardShell
      initialRepositories={initialRepositories}
      categories={categories}
    />
  );
}
