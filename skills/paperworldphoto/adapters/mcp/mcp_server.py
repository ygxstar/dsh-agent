#!/usr/bin/env python3
"""
PaperWorldPhoto MCP Server
Exposes PaperWorldPhoto compiler and quality gate as MCP Tools for Claude Desktop, Cursor, and any MCP Client.
"""
import sys
import os
import json

# Ensure parent directory is in sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
from src.compiler import PaperWorldCompiler
from src.quality_gate import QualityGate

def handle_request(req):
    method = req.get("method")
    params = req.get("params", {})
    req_id = req.get("id")

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "result": {
                "tools": [
                    {
                        "name": "compile_paper_world_prompt",
                        "description": "Compile photo semantics into a 3D handcrafted papercraft diorama generation prompt.",
                        "inputSchema": {
                            "type": "object",
                            "properties": {
                                "subject_desc": {"type": "string", "description": "Subject identity, clothing, and posture"},
                                "scene_type": {"type": "string", "enum": ["cafe", "park", "urban_transit", "seaside", "home", "pet_nature", "festival_night"], "default": "cafe"},
                                "arch_style": {"type": "string", "default": "historic_red_brick_urban"},
                                "aspect_ratio": {"type": "string", "enum": ["1:1", "4:3", "3:4", "16:9", "9:16"], "default": "4:3"},
                                "mandatory_florals": {"type": "boolean", "default": True}
                            },
                            "required": ["subject_desc"]
                        }
                    },
                    {
                        "name": "get_available_presets",
                        "description": "List all supported architecture and scene presets.",
                        "inputSchema": {"type": "object"}
                    }
                ]
            }
        }
    elif method == "tools/call":
        tool_name = params.get("name")
        args = params.get("arguments", {})
        compiler = PaperWorldCompiler()

        if tool_name == "compile_paper_world_prompt":
            res = compiler.compile(
                subject_desc=args.get("subject_desc", "person"),
                scene_type=args.get("scene_type", "cafe"),
                arch_style=args.get("arch_style", "historic_red_brick_urban"),
                aspect_ratio=args.get("aspect_ratio", "4:3"),
                mandatory_florals=args.get("mandatory_florals", True)
            )
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(res, ensure_ascii=False, indent=2)}]
                }
            }
        elif tool_name == "get_available_presets":
            presets = {
                "scenes": list(compiler.scene_presets.keys()),
                "architectures": list(compiler.arch_presets.keys())
            }
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "content": [{"type": "text", "text": json.dumps(presets, ensure_ascii=False, indent=2)}]
                }
            }

    return {
        "jsonrpc": "2.0",
        "id": req_id,
        "error": {"code": -32601, "message": f"Method {method} not found"}
    }

def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            req = json.loads(line)
            resp = handle_request(req)
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()
        except Exception as e:
            sys.stderr.write(f"Error: {e}\n")

if __name__ == "__main__":
    main()
