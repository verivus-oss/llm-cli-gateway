import llm

from .models import GatewayClaude, GatewayCodex, GatewayGemini


@llm.hookimpl
def register_models(register):
    register(GatewayClaude())
    register(GatewayCodex())
    register(GatewayGemini())
