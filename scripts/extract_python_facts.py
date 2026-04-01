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

    imports: list[str] = []
    declared_symbols: list[dict[str, str]] = []
    exported_symbols: list[dict[str, str]] = []
    local_calls: list[str] = []
    decorators: list[str] = []

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(alias.name)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            prefix = "." * node.level
            imports.append(f"{prefix}{module}" if module else prefix or "")
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            symbol = normalize_symbol(node.name, "function")
            if symbol:
                declared_symbols.append(symbol)
                exported_symbols.append(symbol)
            for decorator in node.decorator_list:
                name = dotted_call_name(decorator)
                if name:
                    decorators.append(name)
        elif isinstance(node, ast.ClassDef):
            symbol = normalize_symbol(node.name, "class")
            if symbol:
                declared_symbols.append(symbol)
                exported_symbols.append(symbol)
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    symbol = normalize_symbol(target.id, "variable")
                    if symbol:
                        declared_symbols.append(symbol)
        elif isinstance(node, ast.Call):
            name = dotted_call_name(node.func)
            if name:
                local_calls.append(name)

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

    result: dict[str, Any] = {
        "language": "Python",
        "frameworkRole": infer_framework_role(file_path, is_entrypoint, is_handler, declared_symbols),
        "declaredSymbols": declared_symbols[:12],
        "exportedSymbols": exported_symbols[:10],
        "imports": list(dict.fromkeys(filter(None, imports)))[:24],
        "localCalls": list(dict.fromkeys(filter(None, local_calls)))[:24],
        "configTouches": list(dict.fromkeys(config_touches))[:8],
        "externalCalls": list(dict.fromkeys(external_calls))[:8],
        "isEntrypoint": is_entrypoint,
        "isHandler": is_handler,
    }

    print(json.dumps(result), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
