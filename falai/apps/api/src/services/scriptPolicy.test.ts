import { describe, expect, it } from "vitest";
import { findBlockedScriptTerms } from "./scriptPolicy.js";

const M1_ANTIGO =
  "Boa tarde. Falamos da DinheiroFácil, no âmbito de um processo registado em seu nome. Registamos um pagamento em atraso. " +
  "Informamos que, se o pagamento não for regularizado, o processo poderá ser encaminhado para cobrança judicial. " +
  "Nesse caso, estão previstas medidas como a penhora de bens e o desconto em vencimento ou salário, nos termos da lei. " +
  "Registamos ainda que o seu nome poderá constar na lista de devedores junto das centrais de informação de crédito.";

const M1_V3 =
  "Boa tarde. Falamos da DinheiroFácil. O pagamento do seu empréstimo encontra-se em atraso e continua por regularizar. " +
  "É importante resolver esta situação o quanto antes. Enquanto o valor estiver em atraso, podem ser aplicados custos " +
  "adicionais, conforme o seu contrato, e o atraso pode ser comunicado à Central de Informação de Crédito, o que pode " +
  "dificultar a obtenção de crédito no futuro. Pode pagar através da aplicação DinheiroFácil. Se tiver dificuldades em " +
  "pagar, contacte o nosso apoio ao cliente: podemos analisar uma solução consigo. Se já efectuou o pagamento, por favor " +
  "ignore esta mensagem. Obrigado.";

describe("findBlockedScriptTerms", () => {
  it("recusa o script M1+ antigo e diz porquê", () => {
    expect(findBlockedScriptTerms(M1_ANTIGO)).toEqual([
      "penhora",
      "cobrança judicial",
      "desconto no salário",
      "lista de devedores",
      "processo registado em seu nome",
    ]);
  });

  it("aceita o M1+ V3 e os lembretes de cobrança normais", () => {
    expect(findBlockedScriptTerms(M1_V3)).toEqual([]);
    expect(findBlockedScriptTerms(
      "Olá, fala a Fácil Crédito. O seu pagamento encontra-se em atraso há mais de quinze dias e a situação requer atenção urgente."
    )).toEqual([]);
  });

  it("ignora acentos, maiúsculas e espaços a mais", () => {
    expect(findBlockedScriptTerms("PENHÓRA  de bens")).toEqual(["penhora"]);
    expect(findBlockedScriptTerms("Cobranca\n judicial")).toEqual(["cobrança judicial"]);
    expect(findBlockedScriptTerms("vamos a tribunal")).toEqual(["tribunal"]);
  });

  it("não confunde palavras parecidas", () => {
    expect(findBlockedScriptTerms("A cobrança será feita na data acordada.")).toEqual([]);
    expect(findBlockedScriptTerms("O seu processo de crédito foi aprovado.")).toEqual([]);
    expect(findBlockedScriptTerms("Consulte a lista de pagamentos na aplicação.")).toEqual([]);
  });
});
