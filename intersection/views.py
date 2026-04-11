from django.shortcuts import render

def simulation_view(request):
    return render(request, 'intersection/simulation.html')
