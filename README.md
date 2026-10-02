# Modelagem de séries temporais via métodos de regressão multivariada

Dashboard estático para a apresentação do trabalho, com cálculo inteiramente no navegador. Abra a versão publicada ou sirva `dist/` por HTTP (`python -m http.server 8765 --directory dist`). Nenhuma instalação de pacote é necessária.

## Dados

- `dist/assets/values.f32` e `times.i64` são uma conversão sem perdas estruturais do `df_total.csv` enviado: 52.273 linhas, 14 sensores, na ordem das linhas. Os valores numéricos são codificados em Float32 para reduzir o tamanho de transferência.
- `dist/assets/cached-weighted-ar.f32` contém os 575.370 valores previstos de `resultados_pond.csv`, indexados por `treino` e `lag_usado` (12 lags por janela). Os resultados originais foram ajustados com valores reais em cada janela, portanto são uma análise separada da previsão recursiva interativa. Na origem, usam alvo `364602_31231_FI_305`, 4.320 pontos de treino e todos os sensores, inclusive o próprio alvo defasado. A vista completa seleciona uma sequência de lags 1..lag_max por origem e avança para a última data prevista. Ela amostra apenas o desenho quando necessário; as métricas incluem todos os pontos válidos.
- Um CSV novo pode ser carregado localmente com coluna de data/hora e colunas numéricas. O arquivo fica apenas na memória da aba; os resultados pré-calculados se aplicam somente aos dados originais.

## Métodos

- Regressão linear e regressão linear ponderada: ajustam `Y(t)` com as medições anteriores ao início escolhido e exibem a série prevista somente entre as datas **Início da previsão** e **Fim da previsão**. Não usam treino, horizonte, lag ou janelas; os valores dos sensores em cada data são usados como preditores observados.
- Autorregressão: em cada origem, ajusta modelos para lags `1..lag_max` e prevê os próximos pontos consecutivos usando os sensores do último registro de treino. Ao chegar ao lag máximo, a janela de treino desliza até a última data prevista. O valor previsto do alvo é usado na nova origem e incorporado ao treino móvel; os demais sensores da nova origem são observados no CSV. A variável alvo defasada é incluída automaticamente entre os preditores.
- Versões ponderadas aplicam pesos lineares de 0 (mais antigo) a 1 (mais recente), como na rotina do notebook. O ajuste usa equações normais com centralização, escala e leve regularização numérica; pode haver pequenas diferenças em relação à pseudoinversa e ao arquivo pré-calculado.
- Cada janela seguinte cobre o horizonte escolhido e começa no ponto seguinte ao último previsto na janela anterior. Dentro dela, a autorregressão é reajustada a cada bloco de até `lag_max` passos sem usar valores reais futuros do alvo. Cada data tem uma previsão única. MAE, RMSE e R² são medidos apenas nos pontos previstos que aparecem no gráfico.
- Correlações de Pearson são calculadas em janelas consecutivas de 30 dias a partir da primeira medição, conforme o notebook. Valores constantes aparecem sem coeficiente.

Os horários são interpretados como relógio civil UTC para preservar a data/hora escrita no CSV. O intervalo de 10 minutos descreve apenas o arquivo padrão; arquivos novos mantêm seus horários reais.
