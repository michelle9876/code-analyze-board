#!/usr/bin/env python3

import ast
import json
import re
import sys
from typing import Any, Optional


def normalize_symbol(name: Optional[str], kind: str) -> Optional[dict[str, str]]:
    if not name:
        return None
    return {"name": name, "kind": kind.lower().replace(" ", "-")}


def dotted_call_name(node: ast.AST) -> Optional[str]:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        parent = dotted_call_name(node.value)
        return f"{parent}.{node.attr}" if parent else node.attr
    if isinstance(node, ast.Call):
        return dotted_call_name(node.func)
    return None


def infer_framework_role(path_value: str, is_entrypoint: bool, is_handler: bool, declared_symbols: list[dict[str, str]]) -> str:
    lower = path_value.lower()
    if is_handler or "/api/" in lower or "route.py" in lower or "controller" in lower:
        return "API handler"
    if "server" in lower or "main.py" in lower or "cli" in lower or "worker" in lower or is_entrypoint:
        return "Runtime entry"
    if "config" in lower or "settings" in lower or lower.endswith("pyproject.toml"):
        return "Configuration module"
    if "service" in lower or "client" in lower or "gateway" in lower:
        return "Service module"
    if "model" in lower or "schema" in lower or "repository" in lower or "cache" in lower:
        return "Data access module"
    if any(symbol["name"].startswith("Test") for symbol in declared_symbols):
        return "Test module"
    return "Python module"


class FactVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.imports: list[str] = []
        self.declared_symbols: list[dict[str, str]] = []
        self.exported_symbols: list[dict[str, str]] = []
        self.local_calls: list[str] = []
        self.local_call_edges: list[dict[str, str]] = []
        self.decorators: list[str] = []
        self.scope_stack: list[str] = []

    def visit_Import(self, node: ast.Import) -> Any:
        for alias in node.names:
            self.imports.append(alias.name)
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> Any:
        module = node.module or ""
        prefix = "." * node.level
        self.imports.append(f"{prefix}{module}" if module else prefix or "")
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> Any:
        symbol = normalize_symbol(node.name, "function")
        if symbol:
            self.declared_symbols.append(symbol)
            self.exported_symbols.append(symbol)
        for decorator in node.decorator_list:
            name = dotted_call_name(decorator)
            if name:
                self.decorators.append(name)
        self.scope_stack.append(node.name)
        self.generic_visit(node)
        self.scope_stack.pop()

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> Any:
        self.visit_FunctionDef(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> Any:
        symbol = normalize_symbol(node.name, "class")
        if symbol:
            self.declared_symbols.append(symbol)
            self.exported_symbols.append(symbol)
        self.generic_visit(node)

    def visit_Assign(self, node: ast.Assign) -> Any:
        for target in node.targets:
            if isinstance(target, ast.Name):
                symbol = normalize_symbol(target.id, "variable")
                if symbol:
                    self.declared_symbols.append(symbol)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> Any:
        name = dotted_call_name(node.func)
        if name:
            self.local_calls.append(name)
            self.local_call_edges.append(
                {
                    "caller": self.scope_stack[-1] if self.scope_stack else "<module>",
                    "callee": name,
                }
            )
        self.generic_visit(node)


def main() -> int:
    if len(sys.argv) < 2:
        print("{}", end="")
        return 0

    file_path = sys.argv[1]
    try:
        with open(file_path, "r", encoding="utf-8") as handle:
            content = handle.read()
    except OSError:
        print("{}", end="")
        return 0

    try:
        tree = ast.parse(content, filename=file_path)
    except SyntaxError:
        print("{}", end="")
        return 0

    visitor = FactVisitor()
    visitor.visit(tree)

    declared_symbols = visitor.declared_symbols
    exported_symbols = visitor.exported_symbols
    local_calls = visitor.local_calls
    decorators = visitor.decorators
    local_call_edges = visitor.local_call_edges

    is_entrypoint = bool(re.search(r'if\s+__name__\s*==\s*["\']__main__["\']', content))
    is_handler = any(
        marker in decorator.lower()
        for decorator in decorators
        for marker in ["route", ".get", ".post", ".put", ".patch", ".delete", "api."]
    )

    config_touches = []
    for pattern, prefix in [
        (r'os\.getenv\(["\']([^"\']+)["\']', "env:"),
        (r'os\.environ(?:\.get)?\(["\']([^"\']+)["\']', "env:"),
    ]:
        config_touches.extend(f"{prefix}{match}" for match in re.findall(pattern, content))

    external_calls = []
    for name in local_calls:
        if re.search(r"requests|httpx|boto3|redis|sqlalchemy|subprocess|publish|send|enqueue", name, re.I):
            external_calls.append(name)

    entry_symbol = None
    if is_entrypoint and any(symbol["name"] == "main" for symbol in declared_symbols):
        entry_symbol = "main"
    elif exported_symbols:
        entry_symbol = exported_symbols[0]["name"]
    elif declared_symbols:
        entry_symbol = declared_symbols[0]["name"]

    result: dict[str, Any] = {
        "language": "Python",
        "frameworkRole": infer_framework_role(file_path, is_entrypoint, is_handler, declared_symbols),
        "declaredSymbols": declared_symbols[:12],
        "exportedSymbols": exported_symbols[:10],
        "imports": list(dict.fromkeys(filter(None, visitor.imports)))[:24],
        "localCalls": list(dict.fromkeys(filter(None, local_calls)))[:24],
        "localCallEdges": list({
            (edge["caller"], edge["callee"]): edge for edge in local_call_edges if edge["caller"] != edge["callee"]
        }.values())[:16],
        "configTouches": list(dict.fromkeys(config_touches))[:8],
        "externalCalls": list(dict.fromkeys(external_calls))[:8],
        "isEntrypoint": is_entrypoint,
        "isHandler": is_handler,
        "entrySymbol": entry_symbol,
    }

    print(json.dumps(result), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
