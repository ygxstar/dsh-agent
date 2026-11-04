import os
import yaml

class PaperWorldCompiler:
    """Universal compiler converting photo semantics into 3D handcrafted paper art prompts."""

    def __init__(self, base_dir=None):
        if base_dir is None:
            base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.base_dir = base_dir
        self.arch_presets = self._load_yaml("presets/architecture_presets.yaml")
        self.scene_presets = self._load_yaml("presets/scene_presets.yaml")

    def _load_yaml(self, rel_path):
        full_path = os.path.join(self.base_dir, rel_path)
        if os.path.exists(full_path):
            with open(full_path, "r", encoding="utf-8") as f:
                return yaml.safe_load(f) or {}
        return {}

    def compile(self, subject_desc, scene_type="cafe", arch_style="historic_red_brick_urban", 
                mandatory_florals=True, aspect_ratio="4:3", target_engine="general"):
        """
        Compile structured photo elements into high-tier generation prompts.
        """
        scene_info = self.scene_presets.get(scene_type, {})
        arch_info = self.arch_presets.get(arch_style, {})

        scene_trans = ", ".join(scene_info.get("paper_translation", ["layered paper scene"]))
        arch_trans = ", ".join(arch_info.get("paper_translation", ["layered cardstock structure"]))

        floral_clause = ""
        if mandatory_florals:
            floral_clause = (
                "Mandatory rich 3D handcrafted paper florals and botanicals rooted into the physical architecture: "
                "multi-layered cut-paper daisies and peonies in textured paper pots, 3D climbing flowering vines crawling up pillars, "
                "and wooden paper crates filled with vibrant blooming paper blossoms. "
            )

        prompt = (
            f"Masterpiece commercial editorial photography of a 3D handcrafted paper art diorama miniature world. "
            f"Subject locking: Strictly preserve original identities, realistic facial features, natural skin pores, lifelike hair gloss, "
            f"exact postures and attire of {subject_desc}. "
            f"Tactile papercraft transformation: Reconstruct all background environment, architecture, and props using layered textured cardstock, "
            f"fine handmade cotton paper, origami folded paper structures, and hand-torn raw deckle edges with visible paper fibers. "
            f"{floral_clause}"
            f"Architecture details: {arch_trans}. "
            f"Scene elements: {scene_trans}. "
            f"Physical lighting & depth: Authentic physical paper thickness with delicate contact drop shadows, shallow depth of field, "
            f"warm natural ambient light. Non-paper photorealistic human subjects seamlessly integrated into the tactile papercraft diorama. "
            f"8k resolution, crisp detail, zero plastic CGI, zero doll faces."
        )

        negative_prompt = (
            "blurry, low quality, plastic skin, doll face, glossy cgi, flat paper texture, cartoon, anime face, "
            "deformed fingers, extra limbs, artificial sticker effect, watermark, signature, logo, floating unsupported fake flowers"
        )

        return {
            "prompt": prompt,
            "negative_prompt": negative_prompt,
            "aspect_ratio": aspect_ratio,
            "scene_type": scene_type,
            "arch_style": arch_style
        }

def compile_paper_prompt(subject_desc, scene_type="cafe", arch_style="historic_red_brick_urban", **kwargs):
    compiler = PaperWorldCompiler()
    return compiler.compile(subject_desc, scene_type=scene_type, arch_style=arch_style, **kwargs)
