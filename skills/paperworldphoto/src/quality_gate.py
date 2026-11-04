class QualityGate:
    """5-Point Automated and Human QA validator for PaperWorld outputs."""

    CHECKLIST = [
        ("Subject Identity", "Are facial features, skin realism, and age accurately preserved without plastic doll look?"),
        ("Action & Pose", "Are postures, hand positions, and held items (e.g. cups, bags) strictly maintained?"),
        ("Scene Semantics", "Is the original spatial context (cafe, park, street) recognizable without hallucinated changes?"),
        ("Tactile Papercraft", "Are paper fibers, dimensional layering, hand-torn edges, and natural contact drop shadows visible?"),
        ("Mandatory Florals", "Are dimensional paper flowers and climbing vines firmly integrated into planters, pillars, or crates?")
    ]

    @classmethod
    def evaluate(cls, scores: dict):
        """Scores between 1-10 for each dimension."""
        total = sum(scores.get(k, 0) for k, _ in cls.CHECKLIST)
        avg = total / len(cls.CHECKLIST)
        passed = all(scores.get(k, 0) >= 7 for k, _ in cls.CHECKLIST)
        return {
            "average_score": avg,
            "passed": passed,
            "details": scores
        }
