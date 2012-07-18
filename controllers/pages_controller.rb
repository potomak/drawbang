#
# GET /about
# GET /faq
# GET /privacy
# GET /tos
#
[:about, :faq, :privacy, :tos].each do |action|
  get "/#{action}" do
    haml action
  end
end