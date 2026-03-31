import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const categories = [
  { name: "Frontend", color: "#165DFF", description: "UI, web app, interaction-heavy projects" },
  { name: "Backend", color: "#0F766E", description: "API, server, data pipeline projects" },
  { name: "AI/ML", color: "#9333EA", description: "Modeling, agents, AI-enabled systems" },
  { name: "DevTools", color: "#D95F3D", description: "CLI, tooling, build and developer workflow" },
  { name: "Infra", color: "#475569", description: "Deployment, infrastructure, platform work" },
  { name: "Library", color: "#8B5CF6", description: "Reusable packages and shared modules" }
];

async function main() {
  for (const category of categories) {
    await prisma.category.upsert({
      where: { name: category.name },
      update: category,
      create: category
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
