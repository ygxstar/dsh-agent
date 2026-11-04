"""
PaperWorldPhoto: Universal 3D Papercraft Diorama Skill Engine
"""
from .compiler import PaperWorldCompiler, compile_paper_prompt
from .quality_gate import QualityGate

__version__ = "1.3.0"
__all__ = ["PaperWorldCompiler", "compile_paper_prompt", "QualityGate"]
