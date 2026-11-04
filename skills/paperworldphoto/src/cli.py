import argparse
import json
from .compiler import PaperWorldCompiler

def main():
    parser = argparse.ArgumentParser(description="PaperWorldPhoto CLI - Universal 3D Papercraft Diorama Prompt Generator")
    parser.add_argument("--subject", required=True, help="Description of the subject (identity, clothing, pose)")
    parser.add_argument("--scene", default="cafe", choices=["park", "urban_transit", "cafe", "seaside", "home", "pet_nature", "festival_night"])
    parser.add_argument("--arch", default="historic_red_brick_urban", help="Architecture style preset name")
    parser.add_argument("--ratio", default="4:3", choices=["1:1", "4:3", "3:4", "16:9", "9:16"])
    parser.add_argument("--json", action="store_true", help="Output result as JSON")

    args = parser.parse_args()
    compiler = PaperWorldCompiler()
    res = compiler.compile(args.subject, scene_type=args.scene, arch_style=args.arch, aspect_ratio=args.ratio)

    if args.json:
        print(json.dumps(res, ensure_ascii=False, indent=2))
    else:
        print("=== [Prompt] ===")
        print(res["prompt"])
        print("\n=== [Negative Prompt] ===")
        print(res["negative_prompt"])

if __name__ == "__main__":
    main()
