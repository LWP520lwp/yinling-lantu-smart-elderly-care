"""银龄岚途智慧养老平台 —— FastAPI 大模型网关。

本包对外暴露一个最小的 HTTP 服务：

- ``app.config``   ：环境变量 / .env 配置加载
- ``app.schemas``  ：Pydantic v2 请求校验模型
- ``app.prompts``  ：中文 system prompt 构建
- ``app.llm``      ：华为云 MaaS 流式调用 + 本地模板降级
- ``app.main``     ：FastAPI 应用、CORS、SSE 路由

启动方式（在 ``backend`` 目录下）::

    uvicorn app.main:app --reload --port 8000
    # 或
    python -m app.main
"""

__all__ = ["__version__"]

__version__ = "1.0.0"