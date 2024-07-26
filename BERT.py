import torch
from transformers import BertTokenizer, BertModel
from sklearn.metrics.pairwise import cosine_similarity

def get_embedding(text, model, tokenizer):
    inputs = tokenizer(text, return_tensors='pt')  # Corrected quotes
    outputs = model(**inputs)
    return outputs.last_hidden_state.mean(dim=1).detach().numpy()

def main():
    sentence = input("Sentence: ")  # Corrected quotes
    keyword = input("Keyword: ")    # Corrected quotes

    tokenizer = BertTokenizer.from_pretrained('bert-base-uncased')  # Corrected quotes
    model = BertModel.from_pretrained('bert-base-uncased')          # Corrected quotes

    sentence_embedding = get_embedding(sentence, model, tokenizer)
    keyword_embedding = get_embedding(keyword, model, tokenizer)

    # Calculate cosine similarity
    similarity_score = cosine_similarity(sentence_embedding, keyword_embedding)[0][0]

    # Truncate embeddings for display
    sentence_embedding_truncated = sentence_embedding[0][:10]
    keyword_embedding_truncated = keyword_embedding[0][:10]

    print(f"Sentence: {sentence}")  # Corrected quotes
    print(f"Embedding: {sentence_embedding_truncated.tolist()} …")  # Corrected quotes
    print(f"Keyword: {keyword}")  # Corrected quotes
    print(f"Embedding: {keyword_embedding_truncated.tolist()} …")  # Corrected quotes
    print(f"Similarity Score: {similarity_score:.4f}")  # Corrected quotes

if __name__ == "__main__":  # Corrected quotes
    main()
